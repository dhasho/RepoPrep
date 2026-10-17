import { useState } from 'react'

const items = ['amber', 'blue', 'coral']
export function App() {
  const [query, setQuery] = useState(() => localStorage.getItem('query') ?? '')
  const visible = items.filter(item => item.includes(query))
  return <input value={query} onChange={event => { setQuery(event.target.value); localStorage.setItem('query', event.target.value) }} aria-label={`Matches: ${visible.length}`} />
}
