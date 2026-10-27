// src/lib/print/escpos.ts

// Basic ESC/POS utility commands
export const ESC = 0x1B;
export const GS = 0x1D;

export const CMD_INIT = [ESC, 0x40]; // Initialize printer
export const CMD_CUT = [GS, 0x56, 0x01]; // Partial paper cut
export const CMD_KICK_DRAWER = [ESC, 0x70, 0x00, 0x19, 0xFA]; // Kick cash drawer (Pin 2, 50ms)

export const ALIGN_LEFT = [ESC, 0x61, 0x00];
export const ALIGN_CENTER = [ESC, 0x61, 0x01];
export const ALIGN_RIGHT = [ESC, 0x61, 0x02];

export const FONT_B_ON = [ESC, 0x4D, 0x01];
export const FONT_B_OFF = [ESC, 0x4D, 0x00];

export const BOLD_ON = [ESC, 0x45, 0x01];
export const BOLD_OFF = [ESC, 0x45, 0x00];

// Text size (0-7 for width and height)
export function setTextSize(width: number, height: number): number[] {
  const size = (width << 4) | height;
  return [GS, 0x21, size];
}

// Convert string to bytes (ASCII/Latin-1)
export function encodeText(text: string): number[] {
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    // Replace non-ASCII chars or use a library for proper encoding if needed
    if (code > 255) code = 63; // '?'
    bytes.push(code);
  }
  return bytes;
}

// Pad string helper
export function padRight(str: string, len: number): string {
  return str.length > len ? str.substring(0, len) : str + ' '.repeat(len - str.length);
}

export function padLeft(str: string, len: number): string {
  return str.length > len ? str.substring(0, len) : ' '.repeat(len - str.length) + str;
}

// Line builder class
export class EscPosBuilder {
  private buffer: number[] = [];
  private width: number;

  // width in characters (32 for 58mm, 48 for 80mm generally)
  constructor(width: number = 32) {
    this.width = width;
    this.addBytes(CMD_INIT);
  }

  addBytes(bytes: number[]): this {
    this.buffer.push(...bytes);
    return this;
  }

  addText(text: string): this {
    this.addBytes(encodeText(text));
    return this;
  }

  addLine(text: string = ''): this {
    this.addText(text + '\n');
    return this;
  }

  alignCenter(): this { return this.addBytes(ALIGN_CENTER); }
  alignLeft(): this { return this.addBytes(ALIGN_LEFT); }
  alignRight(): this { return this.addBytes(ALIGN_RIGHT); }

  boldOn(): this { return this.addBytes(BOLD_ON); }
  boldOff(): this { return this.addBytes(BOLD_OFF); }

  size(width: number, height: number): this {
    return this.addBytes(setTextSize(width, height));
  }

  cut(): this {
    return this.addBytes(CMD_CUT);
  }

  kickDrawer(): this {
    return this.addBytes(CMD_KICK_DRAWER);
  }

  separator(char: string = '-'): this {
    this.addLine(char.repeat(this.width));
    return this;
  }

  // Two columns formatting
  twoColumn(left: string, right: string): this {
    const leftLen = this.width - right.length;
    this.addLine(padRight(left, leftLen) + right);
    return this;
  }

  // Four columns: Qty, Item, Rate, Net
  // Widths configurable, eg: [4, 14, 6, 8] for 32 chars
  fourColumn(col1: string, col2: string, col3: string, col4: string, widths: [number, number, number, number]): this {
    const c1 = padRight(col1.toString(), widths[0]);
    const c2 = padRight(col2.toString(), widths[1]);
    const c3 = padLeft(col3.toString(), widths[2]);
    const c4 = padLeft(col4.toString(), widths[3]);
    this.addLine(`${c1}${c2}${c3}${c4}`);
    return this;
  }

  build(): Uint8Array {
    return new Uint8Array(this.buffer);
  }
}
