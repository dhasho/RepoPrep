import { createServer } from 'node:http'

const routes = new Map([
  ['/health', () => ({ status: 'ok' })],
  ['/items', () => ({ items: ['one', 'two'] })]
])

export const server = createServer((request, response) => {
  const handler = routes.get(new URL(request.url, 'http://localhost').pathname)
  response.writeHead(handler ? 200 : 404, { 'content-type': 'application/json' })
  response.end(JSON.stringify(handler ? handler() : { error: 'not found' }))
})
