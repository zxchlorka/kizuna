import { test } from '@playwright/test'

test.describe('redis stream viewer', () => {
  test.skip(true, 'Playwright MCP validation is environment-blocked in this workspace.')
})
