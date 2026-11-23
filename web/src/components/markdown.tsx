import * as React from "react"
import { cn } from "cn"
import {
  defaultComponents,
  Streamdown,
  useIsCodeFenceIncomplete,
  type ExtraProps,
} from "streamdown"

import { useHighlightedCode } from "@/hooks/use-highlighted-code"
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "@/components/ui/code-block"

function MarkdownCodeBlock({
  code,
  language,
}: {
  code: string
  language: string
}) {
  // True while the closing fence has not arrived yet.
  const incomplete = useIsCodeFenceIncomplete()
  const lines = useHighlightedCode(code, language)

  return (
    <CodeBlock>
      <CodeBlockHeader>
        <CodeBlockTitle>{language || "text"}</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={code} disabled={incomplete} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent lineNumbers>
        {lines.map((line, index) => (
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  )
}

function MarkdownCode({
  node,
  className,
  children,
  ...props
}: React.ComponentProps<"code"> & ExtraProps) {
  // Streamdown marks fenced code with data-block. Inline code stays inline.
  if (!("data-block" in props)) {
    return (
      <code
        className={cn(
          "rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.9em]",
          className
        )}
        {...props}
      >
        {children}
      </code>
    )
  }

  return (
    <MarkdownCodeBlock
      code={typeof children === "string" ? children : ""}
      language={/language-(\S+)/.exec(className ?? "")?.[1] ?? ""}
    />
  )
}

// True for a link to this page's own origin: a relative URL, a fragment, or an
// absolute http(s) URL with the same origin. Anything else is another site.
function isSameOrigin(href: string) {
  if (typeof window === "undefined") return false
  try {
    const url = new URL(href, window.location.href)
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin === window.location.origin
    )
  } catch {
    return false
  }
}

function MarkdownLink({
  node,
  className,
  href,
  children,
  ...props
}: React.ComponentProps<"a"> & ExtraProps) {
  // Streamdown's link safety asks before every link. Only another origin is
  // external: a link to this site opens directly, in the same tab.
  if (!href || href === "streamdown:incomplete-link" || !isSameOrigin(href)) {
    const StreamdownLink = defaultComponents.a
    return (
      <StreamdownLink node={node} className={className} href={href} {...props}>
        {children}
      </StreamdownLink>
    )
  }

  // Streamdown's rehype plugins give every link target="_blank" and rel; a
  // link to this site leaves them off so it opens in this tab.
  return (
    <a
      data-streamdown="link"
      className={cn("wrap-anywhere font-medium text-primary underline", className)}
      href={href}
      {...props}
      target={undefined}
      rel={undefined}
    >
      {children}
    </a>
  )
}

// Streamdown memoizes on components, so keep the default stable.
const DEFAULT_COMPONENTS = { a: MarkdownLink, code: MarkdownCode }

function Markdown({
  className,
  components = DEFAULT_COMPONENTS,
  controls = false,
  ...props
}: React.ComponentProps<typeof Streamdown>) {
  return (
    <Streamdown
      data-slot="markdown"
      components={components}
      controls={controls}
      className={cn("w-full min-w-0 overflow-hidden", className)}
      {...props}
    />
  )
}

export { Markdown }
