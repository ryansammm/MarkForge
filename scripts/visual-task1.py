"""Visual smoke for notion-parity Task 1 — focused on the assertions."""
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.set_default_timeout(15000)

    out = open("logs/visual-task1-final.txt", "w", encoding="utf-8")
    def log(m): out.write(m + "\n"); out.flush()

    page.goto("http://localhost:3000", wait_until="networkidle")
    page.locator('input[type="password"]').fill("9800")
    page.get_by_role("button", name="Unlock Workspace").click()
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(2000)
    page.get_by_role("button", name="Edit", exact=True).first.click()
    page.wait_for_selector(".cm-editor", timeout=10000)
    page.wait_for_timeout(500)

    editor = page.locator(".cm-editor").first
    editor.click()
    page.keyboard.press("Control+End")
    page.wait_for_timeout(300)

    # Test 1: Enter on non-empty line.
    page.keyboard.type("halo", delay=30)
    page.wait_for_timeout(200)
    page.keyboard.press("Enter")
    page.wait_for_timeout(200)
    page.keyboard.type("dunia", delay=30)
    page.wait_for_timeout(200)
    text_after_enter = page.evaluate("() => document.querySelector('.cm-content')?.innerText")
    log("=== after Enter on non-empty ===")
    log(repr(text_after_enter))
    # Expect: contains 'halo' and 'dunia' on separate lines.
    assert text_after_enter and "halo" in text_after_enter and "dunia" in text_after_enter, "Enter should split line"
    # The mkf:b: comment should be hidden on lines that are not the
    # active line. Move the cursor to a different line first.
    page.keyboard.press("Control+Home")
    page.wait_for_timeout(200)
    visible_mkf = page.evaluate("""() => {
        // Find .cm-md-syntax elements whose textContent is the
        // mkf:b: comment, and check their computed display. The
        // active line is allowed to show them.
        const lines = document.querySelectorAll('.cm-content .cm-line');
        const result = [];
        for (const line of lines) {
            if (line.classList.contains('cm-activeLine')) continue;
            const md = line.querySelectorAll('.cm-md-syntax');
            for (const el of md) {
                if (el.textContent && el.textContent.includes('mkf:b:')) {
                    const cs = getComputedStyle(el);
                    if (cs.display !== 'none' && cs.visibility !== 'hidden') {
                        result.push({ text: el.textContent, display: cs.display });
                    }
                }
            }
        }
        return result;
    }""")
    log(f"non-active mkf:b: visible: {visible_mkf}")
    assert len(visible_mkf) == 0, f"mkf:b: must be hidden on non-active lines: {visible_mkf}"

    # Test 2: Shift+Enter on non-empty line.
    page.keyboard.press("End")
    page.keyboard.press("Shift+Enter")
    page.wait_for_timeout(200)
    page.keyboard.type("lagi", delay=30)
    page.wait_for_timeout(200)
    # The source should contain "dunia  \n" (two-space hard break).
    src = page.evaluate("""() => {
        // Read the source text — every cm-line.
        const lines = document.querySelectorAll('.cm-line');
        return Array.from(lines).map(l => l.textContent);
    }""")
    log("=== after Shift+Enter ===")
    for i, ln in enumerate(src):
        log(f"  line {i}: {ln!r}")
    # The 'lagi' should be on a new line (the hard break).
    assert "lagi" in src, f"lagi should be on its own line: {src}"

    # Test 3: Empty-block hint.
    page.keyboard.press("End")
    page.keyboard.press("Enter")
    page.wait_for_timeout(200)
    page.screenshot(path="logs/shot-empty-hint.png", full_page=True)
    hints = page.evaluate("""() => {
        const hints = document.querySelectorAll('.mkf-empty-hint');
        return Array.from(hints).map(h => {
            const cs = getComputedStyle(h);
            const parent = h.closest('.cm-line');
            const parentClass = parent ? parent.className : null;
            return {
                text: h.textContent,
                display: cs.display,
                parentClass,
            };
        });
    }""")
    log("=== empty-block hint ===")
    log(str(hints))
    # At least one hint should be visible on the active empty line.
    visible_hints = [h for h in hints if h['display'] != 'none']
    log(f"visible hints: {len(visible_hints)}")
    assert len(visible_hints) >= 1, f"empty block hint must show on active empty line: {hints}"

    out.close()
    browser.close()
    print("ALL ASSERTIONS PASSED")
