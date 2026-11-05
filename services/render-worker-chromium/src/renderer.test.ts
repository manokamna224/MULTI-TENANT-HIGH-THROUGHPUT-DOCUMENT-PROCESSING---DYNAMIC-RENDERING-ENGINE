import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisting-safe: use inline vi.fn() inside factory, capture via vi.mocked()
const TEMPLATE_SOURCE = '<html><body>Hello {{name}}</body></html>';
const FAKE_PDF = Buffer.from('%PDF-1.4 fake');

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('<html><body>Hello {{name}}</body></html>'),
}));

import * as fsPromises from 'fs/promises';
const mockReadFile = vi.mocked(fsPromises.readFile);

// Build a mock page that captures calls
const mockPdf       = vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake'));
const mockClosePage = vi.fn().mockResolvedValue(undefined);
const mockSetContent = vi.fn().mockResolvedValue(undefined);
const mockSetJS      = vi.fn().mockResolvedValue(undefined);
const mockIntercept  = vi.fn().mockResolvedValue(undefined);
const mockOnPage     = vi.fn();

const mockPage: any = {
  setJavaScriptEnabled:   mockSetJS,
  setRequestInterception: mockIntercept,
  on:                     mockOnPage,
  setContent:             mockSetContent,
  pdf:                    mockPdf,
  close:                  mockClosePage,
};
const mockBrowser: any = { newPage: vi.fn().mockResolvedValue(mockPage) };

import { ChromiumRenderer } from './renderer';
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

describe('ChromiumRenderer', () => {
  let renderer: ChromiumRenderer;

  beforeEach(() => {
    renderer = new ChromiumRenderer('/templates/html', log);
    vi.clearAllMocks();
    mockReadFile.mockResolvedValue(TEMPLATE_SOURCE as any);
    mockPdf.mockResolvedValue(FAKE_PDF);
  });

  it('renders a template and returns PDF bytes', async () => {
    const result = await renderer.render(mockBrowser, 'measurement_book', { name: 'Alice' });
    expect(result.pdfBytes).toBeInstanceOf(Buffer);
    expect(result.pdfBytes.length).toBeGreaterThan(0);
  });

  it('injects data into the Handlebars template', async () => {
    await renderer.render(mockBrowser, 'measurement_book', { name: 'Alice' });
    const html = mockSetContent.mock.calls[0]?.[0] as string;
    expect(html).toContain('Alice');
  });

  it('caches template on second call (readFile called once)', async () => {
    await renderer.render(mockBrowser, 'measurement_book', { name: 'Test' });
    await renderer.render(mockBrowser, 'measurement_book', { name: 'Test2' });
    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });

  it('closes the page after rendering', async () => {
    await renderer.render(mockBrowser, 'measurement_book', { name: 'Test' });
    expect(mockClosePage).toHaveBeenCalledTimes(1);
  });

  it('closes the page even when pdf() throws', async () => {
    mockPdf.mockRejectedValueOnce(new Error('oom'));
    await expect(renderer.render(mockBrowser, 'measurement_book', { name: 'Test' })).rejects.toThrow('oom');
    expect(mockClosePage).toHaveBeenCalledTimes(1);
  });

  it('throws when template file is missing', async () => {
    mockReadFile.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await expect(renderer.render(mockBrowser, 'missing', {})).rejects.toThrow();
  });
});
