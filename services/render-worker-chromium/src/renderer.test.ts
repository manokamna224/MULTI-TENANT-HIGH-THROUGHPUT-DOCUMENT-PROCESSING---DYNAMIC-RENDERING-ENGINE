/**
 * Unit tests for ChromiumRenderer.
 *
 * Mocks:
 *   - fs/promises — returns a fake template source
 *   - puppeteer-core Browser / Page — returns fake PDF bytes
 *
 * Tests verify:
 *   - render() returns a Buffer with PDF content
 *   - Handlebars template is compiled with the provided data
 *   - Page is closed after rendering (even if pdf() throws)
 *   - Template cache is used on the second call (readFile called once)
 *   - Missing template throws with a useful error
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock fs/promises ──────────────────────────────────────────────────────────

const TEMPLATE_SOURCE = '<html><body>Hello {{name}}</body></html>';
const mockReadFile    = vi.fn().mockResolvedValue(TEMPLATE_SOURCE);
vi.mock('fs/promises', () => ({ readFile: mockReadFile }));

// ── Mock Puppeteer Page ───────────────────────────────────────────────────────

const FAKE_PDF        = Buffer.from('%PDF-1.4 fake');
const mockPdfFn       = vi.fn().mockResolvedValue(FAKE_PDF);
const mockClosePage   = vi.fn().mockResolvedValue(undefined);
const mockSetContent  = vi.fn().mockResolvedValue(undefined);
const mockSetJS       = vi.fn().mockResolvedValue(undefined);
const mockIntercept   = vi.fn().mockResolvedValue(undefined);
const mockOnPage      = vi.fn();

const mockPage: any = {
  setJavaScriptEnabled: mockSetJS,
  setRequestInterception: mockIntercept,
  on:         mockOnPage,
  setContent: mockSetContent,
  pdf:        mockPdfFn,
  close:      mockClosePage,
};

const mockNewPage = vi.fn().mockResolvedValue(mockPage);
const mockBrowser: any = { newPage: mockNewPage };

// ─────────────────────────────────────────────────────────────────────────────

import { ChromiumRenderer } from './renderer';

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

describe('ChromiumRenderer', () => {
  let renderer: ChromiumRenderer;

  beforeEach(() => {
    renderer = new ChromiumRenderer('/templates/html', log);
    vi.clearAllMocks();
    mockReadFile.mockResolvedValue(TEMPLATE_SOURCE);
    mockPdfFn.mockResolvedValue(FAKE_PDF);
  });

  it('renders a template and returns PDF bytes', async () => {
    const result = await renderer.render(mockBrowser, 'measurement_book', { name: 'Alice' });
    expect(result.pdfBytes).toBeInstanceOf(Buffer);
    expect(result.pdfBytes.length).toBeGreaterThan(0);
  });

  it('passes data into the Handlebars template', async () => {
    await renderer.render(mockBrowser, 'measurement_book', { name: 'Alice' });
    // setContent should receive HTML with 'Alice' substituted
    const html = mockSetContent.mock.calls[0]?.[0] as string;
    expect(html).toContain('Alice');
  });

  it('uses the template cache on the second call', async () => {
    await renderer.render(mockBrowser, 'measurement_book', {});
    await renderer.render(mockBrowser, 'measurement_book', {});
    // readFile called once despite two renders
    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });

  it('closes the page after rendering', async () => {
    await renderer.render(mockBrowser, 'measurement_book', {});
    expect(mockClosePage).toHaveBeenCalledTimes(1);
  });

  it('closes the page even if pdf() throws', async () => {
    mockPdfFn.mockRejectedValueOnce(new Error('out of memory'));
    await expect(
      renderer.render(mockBrowser, 'measurement_book', {}),
    ).rejects.toThrow('out of memory');
    expect(mockClosePage).toHaveBeenCalledTimes(1);
  });

  it('throws when template file is missing', async () => {
    mockReadFile.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await expect(
      renderer.render(mockBrowser, 'missing_template', {}),
    ).rejects.toThrow();
  });
});
