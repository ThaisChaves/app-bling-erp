const errorHandling = require('../store-api/error-handling')
const Bling = require('../bling/constructor')
const parseOrder = require('./parsers/order-to-bling/')
const parseStatus = require('./parsers/order-to-bling/status')
const handleJob = require('./handle-job')

module.exports = ({ appSdk, storeId, auth }, blingToken, blingStore, queueEntry, appData, canCreateNew) => {
  const orderId = queueEntry.nextId

  return appSdk.apiRequest(storeId, `/orders/${orderId}.json`, 'GET', null, auth)
    .then(({ response }) => {
      const order = response.data
      if (!order.financial_status) {
        return null
      }

      let blingOrderNumber
      if (order.metafields) {
        const metafield = order.metafields.find(({ field }) => field === 'bling:numero')
        if (metafield) {
          blingOrderNumber = metafield.value
        }
      }
      if (!blingOrderNumber) {
        blingOrderNumber = String(order.number)
      }
      const bling = new Bling(blingToken)

      const job = bling.get(`/pedido/${blingOrderNumber}`)
        .catch(err => {
          if (err.response && err.response.status === 404) {
            return { data: {} }
          }
          throw err
        })

        .then(({ data }) => {
          const blingStatus = parseStatus(order)
          let originalBlingOrder
          if (Array.isArray(data.pedidos)) {
            originalBlingOrder = data.pedidos.find(({ pedido }) => {
              if (String(order.number) === pedido.numeroPedidoLoja) {
                return !blingStore || (String(blingStore) === String(pedido.loja))
              }
              return false
            })
            if (originalBlingOrder) {
              originalBlingOrder = originalBlingOrder.pedido
            } else if (!canCreateNew) {
              return {}
            }
          }

          if (!originalBlingOrder) {
            if (appData.approved_orders_only) {
              switch (blingStatus) {
                case 'em aberto':
                case 'cancelado':
                  return {}
              }
            }
            const blingOrder = parseOrder(order, blingOrderNumber, blingStore, appData, storeId)
            console.log(`#${storeId} ${JSON.stringify(blingOrder)}`)
            return bling.post('/pedido', { pedido: blingOrder })
              .then(() => ({ blingStatus }))
          }
          return { blingStatus }
        })

        .then(({ blingStatus }) => {
          if (blingStatus) {
            return bling.get('/situacao/Vendas').then(({ data }) => {
              if (Array.isArray(data.situacoes)) {
                let blingStatusObj
                const findBlingStatus = statusLabel => {
                  blingStatusObj = data.situacoes.find(({ situacao }) => {
                    return situacao.nome && situacao.nome.toLowerCase() === statusLabel
                  })
                }
                if (Array.isArray(blingStatus)) {
                  for (let i = 0; i < blingStatus.length; i++) {
                    findBlingStatus(blingStatus[i])
                    if (blingStatusObj) {
                      break
                    }
                  }
                } else {
                  findBlingStatus(blingStatus)
                }

                if (blingStatusObj) {
                  return bling.put(`/pedido/${blingOrderNumber}`, {
                    pedido: {
                      idSituacao: Number(blingStatusObj.situacao.id)
                    }
                  })
                }
                return null
              }
              const err = new Error('Sua conta Bling não tem "situacoes" cadastradas ou a API do Bling falhou')
              err.isConfigError = true
              throw err
            })
          }
          return null
        })
      handleJob({ appSdk, storeId }, queueEntry, job)
    })

    .catch(err => {
      if (err.response) {
        const { status } = err.response
        if (status >= 400 && status < 500) {
          const msg = `O pedido ${orderId} não existe (:${status})`
          const err = new Error(msg)
          err.isConfigError = true
          handleJob({ appSdk, storeId }, queueEntry, Promise.reject(err))
          return null
        }
      }
      errorHandling(err)
      throw err
    })
}
