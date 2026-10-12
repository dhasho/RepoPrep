import React, { useCallback, useState } from 'react'
import { createRoot } from 'react-dom/client'
import TermPopover from '../../../src/components/TermPopover'

declare global {
  interface Window {
    nativeTest: {
      state(): Promise<Record<string, unknown>>
      pushDelta(text: string): Promise<void>
      resetScenario(kind: 'glossary' | 'stream'): Promise<void>
    }
  }
}

function Fixture() {
  const [open, setOpen] = useState(true)
  const [streaming, setStreaming] = useState(false)
  const [revision, setRevision] = useState(0)
  const close = useCallback(() => setOpen(false), [])
  React.useEffect(() => {
    const change = (event: Event) => {
      const kind = (event as CustomEvent<'glossary' | 'stream' | 'close'>).detail
      if (kind === 'close') setOpen(false)
      else {
        setOpen(true)
        setStreaming(kind === 'stream')
        setRevision((value) => value + 1)
      }
    }
    window.addEventListener('native-test-scenario', change)
    return () => window.removeEventListener('native-test-scenario', change)
  }, [])
  const anchor = new DOMRect(90, 70, 20, 20)
  return <>
    <div id="outside-scroll">{Array.from({ length: 70 }, (_, i) => <p key={i}>Outside page content {i}</p>)}</div>
    {open && <TermPopover key={revision}
      term="Native wheel regression"
      anchor={anchor}
      question="Why does a native wheel need to preserve the open popover?"
      snippet="The real component owns this scrollable content."
      glossaryHint={streaming ? undefined : Array.from({ length: 100 }, (_, i) => `Glossary paragraph ${i}: a long definition for real Chromium scrolling.`).join('\n\n')}
      projectSummary="Isolated native wheel fixture"
      profileId="fixture-profile"
      onClose={close}
    />}
    <output id="fixture-ready">ready</output>
  </>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
