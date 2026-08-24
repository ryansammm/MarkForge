"use client";

import React, { useState, useMemo } from 'react';
import { ChevronDown, ChevronRight, Clock } from 'lucide-react';
import { MarkdownDocument } from '@/lib/file-store';
import type { OpenIntent } from '@/lib/tabs';
import { openHandlers } from './tab-gestures';

interface RecentEditsPanelProps {
  /** Map of path → document */
  documents: Record<string, MarkdownDocument>;
  /** Number of items to show */
  count?: number;
  /** Callback when a document is selected */
  onSelectDoc: (path: string, intent: OpenIntent) => void;
}

/**
 * Collapsible panel that lists the most recently edited documents, based on the
 * `updatedAt` timestamp stored in each document's frontmatter.
 */
export function RecentEditsPanel({ documents, count = 5, onSelectDoc }: RecentEditsPanelProps) {
  const [isOpen, setIsOpen] = useState(true);

  const recent = useMemo(() => {
    return Object.entries(documents)
      .filter(([, doc]) => doc.updatedAt)
      .sort((a, b) => (b[1].updatedAt ?? '').localeCompare(a[1].updatedAt ?? ''))
      .slice(0, count);
  }, [documents, count]);

  if (recent.length === 0) return null;

  return (
    <div className="p-4">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="flex w-full items-center justify-between gap-2 pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
      >
        <div className="flex items-center gap-2">
          <Clock className="size-4 text-primary" />
          <span>Recent Edits ({recent.length})</span>
        </div>
        {isOpen ? (
          <ChevronDown className="size-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 text-muted-foreground" />
        )}
      </button>

      {isOpen && (
        <ul className="mt-2 space-y-2 text-xs">
          {recent.map(([path, doc]) => (
            <li key={path} className="flex flex-col">
              <button
                type="button"
                className="text-left font-medium text-foreground hover:text-primary hover:underline truncate"
                {...openHandlers((intent) => onSelectDoc(path, intent))}
                title={doc.title ?? path}
              >
                {doc.title ?? path}
              </button>
              <span className="text-[10px] text-muted-foreground">
                {new Date(doc.updatedAt!).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
