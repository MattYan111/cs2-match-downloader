export type LosslessJsonNode =
  | { type: 'null'; raw: 'null'; start: number; end: number }
  | { type: 'boolean'; value: boolean; raw: 'true' | 'false'; start: number; end: number }
  | { type: 'string'; value: string; raw: string; start: number; end: number }
  | { type: 'number'; raw: string; start: number; end: number }
  | { type: 'array'; items: LosslessJsonNode[]; start: number; end: number }
  | { type: 'object'; entries: LosslessObjectEntry[]; start: number; end: number };

export interface LosslessObjectEntry {
  key: string;
  rawKey: string;
  value: LosslessJsonNode;
}

export class LosslessJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LosslessJsonError';
  }
}

const MAX_DEPTH = 256;

export function decodeUtf8Strict(buffer: Buffer | Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new LosslessJsonError('接口响应不是有效的 UTF-8 文本，无法无损处理');
  }
}

export function parseLosslessJson(text: string): LosslessJsonNode {
  let index = 0;
  const len = text.length;

  function skipWs(): void {
    while (index < len) {
      const ch = text.charCodeAt(index);
      if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) {
        index++;
      } else {
        break;
      }
    }
  }

  function fail(reason: string): never {
    throw new LosslessJsonError(`JSON 解析失败（位置 ${index}）：${reason}`);
  }

  function parseStringToken(): { value: string; raw: string; start: number; end: number } {
    const start = index;
    if (text.charCodeAt(index) !== 0x22) fail('期望字符串起始引号');
    index++;
    while (index < len) {
      const ch = text.charCodeAt(index);
      if (ch === 0x22) {
        index++;
        const raw = text.slice(start, index);
        let value: string;
        try {
          value = JSON.parse(raw) as string;
        } catch {
          fail('字符串转义无效');
        }
        return { value, raw, start, end: index };
      }
      if (ch === 0x5c) {
        index++;
        if (index >= len) fail('字符串转义未闭合');
        const esc = text.charCodeAt(index);
        if (
          esc === 0x22 ||
          esc === 0x5c ||
          esc === 0x2f ||
          esc === 0x62 ||
          esc === 0x66 ||
          esc === 0x6e ||
          esc === 0x72 ||
          esc === 0x74
        ) {
          index++;
        } else if (esc === 0x75) {
          index++;
          for (let i = 0; i < 4; i++) {
            if (index >= len) fail('Unicode 转义不完整');
            const hex = text.charCodeAt(index);
            const isHex =
              (hex >= 0x30 && hex <= 0x39) ||
              (hex >= 0x41 && hex <= 0x46) ||
              (hex >= 0x61 && hex <= 0x66);
            if (!isHex) fail('Unicode 转义包含非十六进制字符');
            index++;
          }
        } else {
          fail('未知字符串转义');
        }
      } else if (ch <= 0x1f) {
        fail('字符串包含未转义控制字符');
      } else {
        index++;
      }
    }
    return fail('字符串未闭合');
  }

  function parseNumberToken(): LosslessJsonNode {
    const start = index;
    if (text.charCodeAt(index) === 0x2d) {
      index++;
    }
    if (index >= len) fail('数字格式不完整');
    const first = text.charCodeAt(index);
    if (first === 0x30) {
      index++;
      if (index < len) {
        const next = text.charCodeAt(index);
        if (next >= 0x30 && next <= 0x39) fail('数字不允许前导零');
      }
    } else if (first >= 0x31 && first <= 0x39) {
      index++;
      while (index < len) {
        const d = text.charCodeAt(index);
        if (d >= 0x30 && d <= 0x39) index++;
        else break;
      }
    } else {
      fail('无效数字');
    }

    if (index < len && text.charCodeAt(index) === 0x2e) {
      index++;
      if (index >= len || text.charCodeAt(index) < 0x30 || text.charCodeAt(index) > 0x39) {
        fail('小数点后缺少数字');
      }
      while (index < len) {
        const d = text.charCodeAt(index);
        if (d >= 0x30 && d <= 0x39) index++;
        else break;
      }
    }

    if (index < len && (text.charCodeAt(index) === 0x65 || text.charCodeAt(index) === 0x45)) {
      index++;
      if (index < len && (text.charCodeAt(index) === 0x2b || text.charCodeAt(index) === 0x2d)) {
        index++;
      }
      if (index >= len || text.charCodeAt(index) < 0x30 || text.charCodeAt(index) > 0x39) {
        fail('指数缺少数字');
      }
      while (index < len) {
        const d = text.charCodeAt(index);
        if (d >= 0x30 && d <= 0x39) index++;
        else break;
      }
    }

    return {
      type: 'number',
      raw: text.slice(start, index),
      start,
      end: index
    };
  }

  function parseValue(depth: number): LosslessJsonNode {
    if (depth > MAX_DEPTH) fail('JSON 嵌套层级过深');
    skipWs();
    if (index >= len) fail('意外结束');
    const start = index;
    const ch = text.charCodeAt(index);

    if (ch === 0x7b) {
      index++;
      const entries: LosslessObjectEntry[] = [];
      skipWs();
      if (index < len && text.charCodeAt(index) === 0x7d) {
        index++;
        return { type: 'object', entries, start, end: index };
      }
      while (true) {
        skipWs();
        const keyTok = parseStringToken();
        skipWs();
        if (text.charCodeAt(index) !== 0x3a) fail('期望冒号 :');
        index++;
        const value = parseValue(depth + 1);
        entries.push({ key: keyTok.value, rawKey: keyTok.raw, value });
        skipWs();
        if (index >= len) fail('对象未闭合');
        const sep = text.charCodeAt(index);
        if (sep === 0x2c) {
          index++;
        } else if (sep === 0x7d) {
          index++;
          return { type: 'object', entries, start, end: index };
        } else {
          fail('对象中期望逗号或右大括号');
        }
      }
    }

    if (ch === 0x5b) {
      index++;
      const items: LosslessJsonNode[] = [];
      skipWs();
      if (index < len && text.charCodeAt(index) === 0x5d) {
        index++;
        return { type: 'array', items, start, end: index };
      }
      while (true) {
        items.push(parseValue(depth + 1));
        skipWs();
        if (index >= len) fail('数组未闭合');
        const sep = text.charCodeAt(index);
        if (sep === 0x2c) {
          index++;
        } else if (sep === 0x5d) {
          index++;
          return { type: 'array', items, start, end: index };
        } else {
          fail('数组中期望逗号或右方括号');
        }
      }
    }

    if (ch === 0x22) {
      const str = parseStringToken();
      return { type: 'string', value: str.value, raw: str.raw, start: str.start, end: str.end };
    }

    if (ch === 0x74 && text.startsWith('true', index)) {
      index += 4;
      return { type: 'boolean', value: true, raw: 'true', start, end: index };
    }

    if (ch === 0x66 && text.startsWith('false', index)) {
      index += 5;
      return { type: 'boolean', value: false, raw: 'false', start, end: index };
    }

    if (ch === 0x6e && text.startsWith('null', index)) {
      index += 4;
      return { type: 'null', raw: 'null', start, end: index };
    }

    if (ch === 0x2d || (ch >= 0x30 && ch <= 0x39)) {
      return parseNumberToken();
    }

    return fail('遇到非法字符');
  }

  const root = parseValue(0);
  skipWs();
  if (index !== len) {
    fail('JSON 末尾存在多余内容');
  }
  return root;
}

export function serializeLosslessJson(node: LosslessJsonNode, indentSize = 2): string {
  function write(current: LosslessJsonNode, depth: number): string {
    switch (current.type) {
      case 'null':
      case 'boolean':
      case 'number':
      case 'string':
        return current.raw;
      case 'array': {
        if (current.items.length === 0) return '[]';
        const pad = ' '.repeat((depth + 1) * indentSize);
        const closePad = ' '.repeat(depth * indentSize);
        const body = current.items.map((item) => `${pad}${write(item, depth + 1)}`).join(',\n');
        return `[\n${body}\n${closePad}]`;
      }
      case 'object': {
        if (current.entries.length === 0) return '{}';
        const pad = ' '.repeat((depth + 1) * indentSize);
        const closePad = ' '.repeat(depth * indentSize);
        const body = current.entries
          .map((entry) => `${pad}${entry.rawKey}: ${write(entry.value, depth + 1)}`)
          .join(',\n');
        return `{\n${body}\n${closePad}}`;
      }
    }
  }
  return write(node, 0);
}

export function getObjectProp(node: LosslessJsonNode | undefined, key: string): LosslessJsonNode | undefined {
  if (!node || node.type !== 'object') return undefined;
  let found: LosslessJsonNode | undefined;
  for (const entry of node.entries) {
    if (entry.key === key) found = entry.value;
  }
  return found;
}

export function asOptionalString(node: LosslessJsonNode | undefined): string | null {
  if (!node || node.type === 'null') return null;
  if (node.type === 'string') return node.value;
  return null;
}

export function asIdString(node: LosslessJsonNode | undefined, fieldName: string): string | null {
  if (!node || node.type === 'null') return null;
  if (node.type === 'string') return node.value;
  if (node.type === 'number') {
    if (!/^-?\d+$/.test(node.raw)) {
      throw new LosslessJsonError(`字段 ${fieldName} 为非整数数字，无法无损作为标识处理`);
    }
    return node.raw;
  }
  throw new LosslessJsonError(`字段 ${fieldName} 类型非字符串或整数`);
}

export function asSafeNumber(node: LosslessJsonNode | undefined, fieldName: string): number | null {
  if (!node || node.type === 'null') return null;
  if (node.type !== 'number') {
    throw new LosslessJsonError(`字段 ${fieldName} 不是数字`);
  }
  const n = Number(node.raw);
  if (!Number.isFinite(n)) {
    throw new LosslessJsonError(`字段 ${fieldName} 超出可表示数值范围`);
  }
  if (/^-?\d+$/.test(node.raw) && !Number.isSafeInteger(n)) {
    throw new LosslessJsonError(`字段 ${fieldName} 超出安全整数范围，无法无损转为 JS 数字`);
  }
  return n;
}

export function asCursorValue(node: LosslessJsonNode | undefined): string | number | null {
  if (!node || node.type === 'null') return null;
  if (node.type === 'string') return node.value;
  if (node.type === 'number') {
    if (/^-?\d+$/.test(node.raw)) {
      const n = Number(node.raw);
      return Number.isSafeInteger(n) ? n : node.raw;
    }
    return node.raw;
  }
  return null;
}
