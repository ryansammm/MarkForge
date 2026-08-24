"use client";

import React, { useState, useMemo } from 'react';
import { ChevronDown, ChevronRight, List } from 'lucide-react';
import { MarkdownDocument } from '@/lib/file-store';
import { extractHeadings } from '@/lib/markdown/headings';

interface TOCPanelProps {
  document: MarkdownDocument | null;
  /**
   * The active document's body.
   *
   * Only the open document needs an outline, and its body has already been fetched
   * for the reading view — so this needs no extra request, and it does not depend on
   * the index carrying bodies for every document in the workspace.
   */
  body: string | null;
  /** Receives the rendered heading's DOM id, which is what the view scrolls to. */
  onSelectHeading: (slug: string) => void;
}

/** Collapsible Table of Contents panel based on Markdown headings */
export function TOCPanel({ document, body, onSelectHeading }: TOCPanelProps) {
  const [isOpen, setIsOpen] = useState(true);

  // Extraction moved out of this component so the panel and the renderer agree on
  // what a heading is — and on what its id will be. The version that lived here
  // counted `#` comments inside fenced code blocks, which is why an outline could
  // list lines that appear nowhere on the page as sections.
  const headings = useMemo(() => (document && body ? extractHeadings(body) : []), [document, body]);

  if (headings.length === 0) return null;

  return (
    <div className="p-4">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="flex w-full items-center justify-between gap-2 pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
      >
        <div className="flex items-center gap-2">
          <List className="size-4 text-primary" />
          <span>Outline ({headings.length})</span>
        </div>
        {isOpen ? (
          <ChevronDown className="size-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 text-muted-foreground" />
        )}
      </button>

      {isOpen && (
        <div className="mt-2 flex flex-col gap-1 text-sm">
          {headings.map((h) => (
            <button
              key={h.line}
              onClick={() => onSelectHeading(h.slug)}
              className="text-left text-xs text-muted-foreground transition-colors hover:text-primary hover:underline truncate"
              style={{ paddingLeft: (h.level - 1) * 10 }}
              title={h.text}
            >
              {h.text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
