import type { Page } from '@playwright/test';

/**
 * Every visible text node inside `root` against its nearest opaque background (WCAG AA with a 0.1
 * margin: 4.6:1, or 3.1:1 for large text). Returns how many were checked and the ones too low.
 */
export async function lowContrast(page: Page, root = 'main') {
  return page.evaluate((selector) => {
    const canvas = document.createElement('canvas').getContext('2d')!;
    const rgba = (color: string) => {
      canvas.clearRect(0, 0, 1, 1);
      canvas.fillStyle = color;
      canvas.fillRect(0, 0, 1, 1);
      return [...canvas.getImageData(0, 0, 1, 1).data];
    };
    const luminance = ([r, g, b]: number[]) =>
      [r!, g!, b!]
        .map((value) => value / 255)
        .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
    const background = (element: Element | null): number[] => {
      for (; element; element = element.parentElement) {
        const value = rgba(getComputedStyle(element).backgroundColor);
        if (value[3]! > 200) return value;
      }
      return rgba(getComputedStyle(document.body).backgroundColor);
    };
    const low: string[] = [];
    let count = 0;
    const walker = document.createTreeWalker(
      document.querySelector(selector)!,
      NodeFilter.SHOW_TEXT,
    );
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const element = node.parentElement!;
      const style = getComputedStyle(element);
      if (!node.textContent!.trim() || !element.checkVisibility({ opacityProperty: true }))
        continue;
      count += 1;
      const [a, b] = [luminance(rgba(style.color)), luminance(background(element))];
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const large =
        parseFloat(style.fontSize) >= 24 ||
        (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
      if (ratio < (large ? 3.1 : 4.6))
        low.push(`${node.textContent!.trim().slice(0, 40)} (${ratio.toFixed(2)})`);
    }
    return { count, low };
  }, root);
}
