import { describe, expect, it } from 'vitest';
import { uuidList } from './form-data';

describe('uuidList', () => {
  const A = '0b6f3c2e-8a51-4d3e-9f0a-2c7d1e5b9a44';
  const B = '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

  function form(values: string[]): FormData {
    const data = new FormData();
    for (const value of values) data.append('ids', value);
    return data;
  }

  it('reads every repeat of the field, lower case and each once', () => {
    // Postgres matches either spelling to one row; a set compared in code
    // would count them as two.
    expect(uuidList(form([A, B, A.toUpperCase()]), 'ids')).toEqual([A, B]);
  });

  it('answers an empty list when nothing was ticked', () => {
    expect(uuidList(form([]), 'ids')).toEqual([]);
  });

  it('refuses the whole list when one id is malformed', () => {
    // Dropping it would save the set without it, which reads as an untick.
    expect(uuidList(form([A, 'not-a-uuid']), 'ids')).toBeUndefined();
    expect(uuidList(form([A, '']), 'ids')).toBeUndefined();
  });
});
