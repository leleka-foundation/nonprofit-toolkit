/* istanbul ignore file -- @preserve production browser adapter uses real Chromium/Xvfb */
import { ResultAsync } from 'neverthrow'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { BrowserPageSession } from '../types/index.ts'
import type { SourceError } from './errors.ts'

export function openDefaultBrowserPage(): ResultAsync<
  BrowserPageSession,
  SourceError
> {
  return ResultAsync.fromPromise(openDefaultBrowserPageUnsafe(), (error) => ({
    type: 'network',
    message: `Failed to launch browser for public compliance source: ${
      error instanceof Error ? error.message : String(error)
    }`,
  }))
}

async function openDefaultBrowserPageUnsafe(): Promise<BrowserPageSession> {
  const display = await startVirtualDisplayIfNeeded()
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? undefined,
    headless: process.env.COMPLIANCE_BROWSER_HEADLESS === '1',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  const page = await browser.newPage()
  return {
    page,
    close: async () => {
      await browser.close()
      await display.close()
    },
  }
}

interface VirtualDisplay {
  readonly close: () => Promise<void>
}

async function startVirtualDisplayIfNeeded(): Promise<VirtualDisplay> {
  if (
    process.env.DISPLAY !== undefined ||
    process.env.COMPLIANCE_BROWSER_HEADLESS === '1'
  ) {
    return { close: () => Promise.resolve() }
  }

  const displayNumber = 90 + Math.floor(Math.random() * 900)
  const display = `:${String(displayNumber)}`
  const child = spawn('Xvfb', [
    display,
    '-screen',
    '0',
    '1280x900x24',
    '-nolisten',
    'tcp',
  ])
  await waitForXvfb(child, display)
  const previousDisplay = process.env.DISPLAY
  process.env.DISPLAY = display
  return {
    close: async () => {
      if (previousDisplay === undefined) {
        delete process.env.DISPLAY
      } else {
        process.env.DISPLAY = previousDisplay
      }
      child.kill()
      await Promise.resolve()
    },
  }
}

function waitForXvfb(
  child: ChildProcessWithoutNullStreams,
  display: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(), 500)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Xvfb ${display} exited with code ${String(code)}`))
    })
  })
}
