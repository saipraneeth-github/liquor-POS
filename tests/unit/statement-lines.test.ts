import { expect, it, vi } from 'vitest';
import { readStatementLines } from '../../frontend/src/bank/statement-lines';
import type { Line } from '../../frontend/src/bank/types';

it('keeps rows beyond the first 500 and requests the correct offsets', async () => {
  const first = Array.from({ length: 500 }, (_, i) => ({ id: String(i) } as Line));
  const last = { id: 'last' } as Line;
  const read = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce([last]);
  const result = await readStatementLines(read);
  expect(result).toHaveLength(501);
  expect(result[500]).toBe(last);
  expect(read.mock.calls).toEqual([[0], [500]]);
});

it('does not treat a failed later page as a complete statement', async () => {
  const read = vi.fn().mockResolvedValueOnce(Array(500).fill({ id: 'row' })).mockRejectedValueOnce(new Error('Connection lost'));
  await expect(readStatementLines(read)).rejects.toThrow('Connection lost');
});

it('handles an empty statement without another request', async () => {
  const read = vi.fn().mockResolvedValue([]);
  expect(await readStatementLines(read)).toEqual([]);
  expect(read).toHaveBeenCalledTimes(1);
});
