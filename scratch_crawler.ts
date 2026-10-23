import { chromium } from '@playwright/test';
import * as fs from 'fs';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const networkLogs: any[] = [];

  page.on('request', req => {
    networkLogs.push({
      type: 'request',
      url: req.url(),
      method: req.method(),
      resourceType: req.resourceType(),
    });
  });

  page.on('response', async res => {
    networkLogs.push({
      type: 'response',
      url: res.url(),
      status: res.status(),
      contentType: res.headers()['content-type'],
    });
  });

  console.log('Navigating to target...');
  try {
    await page.goto('https://zambient.in/lctg/#/', { waitUntil: 'networkidle', timeout: 30000 });
  } catch (err: any) {
    console.log('Wait timeout or navigation error:', err.message);
  }

  await page.waitForTimeout(4000);

  const currentUrl = page.url();
  const title = await page.title();
  const content = await page.content();

  const interactive = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a')).map(a => ({
      text: (a as HTMLElement).innerText.trim(),
      href: a.getAttribute('href'),
      className: a.className,
    }));
    const buttons = Array.from(document.querySelectorAll('button')).map(b => ({
      text: (b as HTMLElement).innerText.trim(),
      type: b.getAttribute('type'),
      className: b.className,
      id: b.id,
    }));
    const inputs = Array.from(document.querySelectorAll('input, select, textarea')).map(i => ({
      tagName: i.tagName,
      type: i.getAttribute('type'),
      name: i.getAttribute('name'),
      placeholder: i.getAttribute('placeholder'),
      id: i.id,
      value: (i as HTMLInputElement).value,
    }));
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).map(h => ({
      tag: h.tagName,
      text: (h as HTMLElement).innerText.trim(),
    }));
    const bodyText = document.body.innerText.slice(0, 3000);

    const scripts = Array.from(document.querySelectorAll('script')).map(s => s.src || s.innerHTML.slice(0, 200));

    return { links, buttons, inputs, headings, bodyText, scripts };
  });

  const output = {
    currentUrl,
    title,
    interactive,
    networkLogs: networkLogs.filter(n => n.resourceType === 'xhr' || n.resourceType === 'fetch' || (n.contentType && n.contentType.includes('json'))),
    allNetworkLogs: networkLogs,
  };

  fs.writeFileSync('C:/Users/yarra/.gemini/antigravity/brain/f4d3f2f4-c56b-4bc9-b504-1e5c498dccc0/scratch/initial_crawl.json', JSON.stringify(output, null, 2));
  fs.writeFileSync('C:/Users/yarra/.gemini/antigravity/brain/f4d3f2f4-c56b-4bc9-b504-1e5c498dccc0/scratch/page.html', content);
  console.log('Done initial crawl. Current URL:', currentUrl, 'Title:', title);

  await browser.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

