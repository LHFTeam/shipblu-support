import { describe, expect, it } from 'vitest';
import { editKind } from './edit';

const BODY = 'حضرتك الشحنة في الطريق\nوهتوصل خلال يومين.';

describe('editKind', () => {
  it('calls the stored text sent as it stands unchanged, whatever the line endings', () => {
    // A submitted textarea posts CRLF; the stored body is LF.
    expect(editKind('حضرتك الشحنة في الطريق\r\nوهتوصل خلال يومين.', [BODY])).toBe('unchanged');
    expect(editKind(`  ${BODY}\n\n`, [BODY])).toBe('unchanged');
  });

  it('calls the stored text sent whole with something added extended', () => {
    expect(editKind(`أهلاً أستاذ أحمد\n\n${BODY}\nرقم الشحنة 123`, [BODY])).toBe('extended');
  });

  it('calls anything else reworded', () => {
    expect(editKind('حضرتك الشحنة هتوصل بكره', [BODY])).toBe('reworded');
    expect(editKind('', [BODY])).toBe('reworded');
  });

  it('tries every body it is given, for a reply whose language was not recorded', () => {
    expect(editKind('Your parcel is on its way.', [BODY, 'Your parcel is on its way.'])).toBe(
      'unchanged',
    );
  });

  it('never matches an empty body, which would be contained in every reply', () => {
    expect(editKind('anything at all', ['', '  '])).toBe('reworded');
  });
});
