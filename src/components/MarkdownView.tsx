// Markdown 渲染 + [[名词]] 转可点击下划线词条
import { Children, Fragment, cloneElement, isValidElement, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

export type OnTerm = (term: string, anchor: DOMRect) => void

/** 把字符串中的 [[名词]] 渲染为带下划线的可点击词条 */
export function TermText({ text, onTerm }: { text: string; onTerm: OnTerm }) {
  const parts = text.split(/(\[\[[^\[\]]+\]\])/g)
  if (parts.length === 1) return <>{text}</>
  return (
    <>
      {parts.map((p, i) => {
        const m = /^\[\[([^\[\]]+)\]\]$/.exec(p)
        if (m) {
          return (
            <span
              key={i}
              className="term-link"
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation()
                onTerm(m[1], e.currentTarget.getBoundingClientRect())
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation()
                  onTerm(m[1], e.currentTarget.getBoundingClientRect())
                }
              }}
            >
              {m[1]}
            </span>
          )
        }
        return <Fragment key={i}>{p}</Fragment>
      })}
    </>
  )
}

/** 递归处理元素树，把所有字符串子节点替换为 TermText */
function renderWithTerms(children: ReactNode, onTerm: OnTerm): ReactNode {
  return Children.map(children, (child, i) => {
    if (typeof child === 'string' || typeof child === 'number') {
      return <TermText key={i} text={String(child)} onTerm={onTerm} />
    }
    if (Array.isArray(child)) {
      return <Fragment key={i}>{renderWithTerms(child, onTerm)}</Fragment>
    }
    if (isValidElement(child)) {
      const props = child.props as { children?: ReactNode }
      if (props.children) {
        return cloneElement(child, { key: child.key ?? i }, renderWithTerms(props.children, onTerm))
      }
      return child
    }
    return child
  })
}

/** 桌面应用内不跳转外部链接 */
function disableLink({ children, href }: { children?: ReactNode; href?: string }) {
  return (
    <a href={href} onClick={(e) => e.preventDefault()} title="应用内不打开外部链接">
      {children}
    </a>
  )
}

export default function MarkdownView({ markdown, onTerm }: { markdown: string; onTerm?: OnTerm }) {
  const termComponents = onTerm
    ? {
        p: ({ children }: { children?: ReactNode }) => <p>{renderWithTerms(children, onTerm)}</p>,
        li: ({ children }: { children?: ReactNode }) => <li>{renderWithTerms(children, onTerm)}</li>,
        td: ({ children }: { children?: ReactNode }) => <td>{renderWithTerms(children, onTerm)}</td>,
        th: ({ children }: { children?: ReactNode }) => <th>{renderWithTerms(children, onTerm)}</th>,
        blockquote: ({ children }: { children?: ReactNode }) => (
          <blockquote>{renderWithTerms(children, onTerm)}</blockquote>
        ),
        h1: ({ children }: { children?: ReactNode }) => <h1>{renderWithTerms(children, onTerm)}</h1>,
        h2: ({ children }: { children?: ReactNode }) => <h2>{renderWithTerms(children, onTerm)}</h2>,
        h3: ({ children }: { children?: ReactNode }) => <h3>{renderWithTerms(children, onTerm)}</h3>,
        h4: ({ children }: { children?: ReactNode }) => <h4>{renderWithTerms(children, onTerm)}</h4>,
        a: disableLink
      }
    : { a: disableLink }

  return (
    <div className="md-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={termComponents}>
        {markdown}
      </ReactMarkdown>
    </div>
  )
}
