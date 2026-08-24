"use client"

import { Moon, Sun } from "lucide-react"
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes"
import { useSyncExternalStore } from "react"

import { cn } from "@/lib/utils"

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange={false}>
      {children}
    </NextThemesProvider>
  )
}

const subscribe = () => () => {}

export function ThemeSwitcher() {
  const { resolvedTheme, setTheme } = useTheme()
  const mounted = useSyncExternalStore(subscribe, () => true, () => false)
  const isDark = mounted && resolvedTheme === "dark"

  return (
    <button
      type="button"
      disabled={!mounted}
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className={cn("theme-switcher", isDark && "is-night")}
      aria-label={`Switch to ${isDark ? "day" : "night"} mode`}
      title={`Switch to ${isDark ? "day" : "night"} mode`}
    >
      <span className="theme-switcher__sky" aria-hidden="true">
        <span className="theme-switcher__stars"><i /><i /><i /></span>
        <span className="theme-switcher__orb">
          <Sun className="theme-switcher__sun" />
          <Moon className="theme-switcher__moon" />
        </span>
      </span>
      <span className="sr-only">{isDark ? "Night mode active" : "Day mode active"}</span>
    </button>
  )
}
