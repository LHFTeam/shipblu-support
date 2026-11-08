import { describe, expect, it } from 'vitest';
import { stubFetch } from '@/lib/testing/fetch';
import { downloadFreshworksImage, KbImageFetchError, kbImageType } from './images';

const FRESHDESK =
  'https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/1/original/a.png?1738062536';

/** A PNG's signature and enough after it to be read as one. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82,
]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1]);
const ascii = (text: string) => new TextEncoder().encode(text);

describe('kbImageType', () => {
  it('reads the four raster types an article may show from their bytes', () => {
    expect(kbImageType(PNG)).toEqual({ contentType: 'image/png', extension: 'png' });
    expect(kbImageType(JPEG)).toEqual({ contentType: 'image/jpeg', extension: 'jpg' });
    expect(kbImageType(ascii('GIF89a\x01\x00\x01\x00\x00\x00'))).toEqual({
      contentType: 'image/gif',
      extension: 'gif',
    });
    expect(kbImageType(ascii('RIFF\x00\x00\x00\x00WEBPVP8 '))).toEqual({
      contentType: 'image/webp',
      extension: 'webp',
    });
  });

  it('refuses what is not one of them, whatever it would be labelled', () => {
    // SVG is a document that runs script; an HTML error page is what a broken
    // CDN link answers with a 200; a PDF and a HEIC are files, not pictures a
    // browser draws in an article everywhere.
    expect(kbImageType(ascii('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(kbImageType(ascii('<!doctype html><html><body>Not found</body></html>'))).toBeNull();
    expect(kbImageType(ascii('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'))).toBeNull();
    expect(kbImageType(ascii('\x00\x00\x00\x18ftypheic\x00\x00\x00\x00'))).toBeNull();
    expect(kbImageType(new Uint8Array(4))).toBeNull();
  });
});

describe('downloadFreshworksImage', () => {
  it('answers the bytes and the type read from them, not the one the server sent', async () => {
    stubFetch(() => new Response(PNG, { status: 200, headers: { 'content-type': 'text/plain' } }));
    const image = await downloadFreshworksImage(FRESHDESK);
    expect(image.contentType).toBe('image/png');
    expect(image.extension).toBe('png');
    expect([...image.content]).toEqual([...PNG]);
  });

  it('asks for nothing outside Freshworks', async () => {
    const fetched = stubFetch(() => new Response(PNG));
    await expect(
      downloadFreshworksImage('https://s3.amazonaws.com/other-bucket/a.png'),
    ).rejects.toThrow(KbImageFetchError);
    expect(fetched).not.toHaveBeenCalled();
  });

  it('follows no redirect, and asks no host it points at', async () => {
    // A redirect is refused as it stands: following it, even to check where it
    // landed, would have the worker ask every host on the way first.
    const fetched = stubFetch(
      () =>
        new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } }),
    );
    await expect(downloadFreshworksImage(FRESHDESK)).rejects.toThrow(
      'answered 302, a redirect to 169.254.169.254, which this job does not follow',
    );
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(fetched.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' });
  });

  it('names the status of a refusal', async () => {
    stubFetch(() => new Response('<Error>AccessDenied</Error>', { status: 403 }));
    await expect(downloadFreshworksImage(FRESHDESK)).rejects.toThrow('answered 403');
  });

  it('refuses a file that is not a picture', async () => {
    stubFetch(() => new Response(ascii('<!doctype html><title>gone</title>'), { status: 200 }));
    await expect(downloadFreshworksImage(FRESHDESK)).rejects.toThrow(
      /not a PNG, JPEG, GIF or WebP/,
    );
  });

  it('refuses a declared length over the cap before reading the body', async () => {
    stubFetch(
      () =>
        new Response(PNG, { status: 200, headers: { 'content-length': String(11 * 1024 * 1024) } }),
    );
    await expect(downloadFreshworksImage(FRESHDESK)).rejects.toThrow(/larger than/);
  });

  it('stops reading a body that passes the cap with no length declared', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    stubFetch(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              sent += 1;
              controller.enqueue(chunk);
              if (sent > 50) controller.close();
            },
          }),
        ),
    );
    await expect(downloadFreshworksImage(FRESHDESK)).rejects.toThrow(/larger than/);
    expect(sent).toBeLessThan(20);
  });

  it('says a deadline passed in words, not as an abort', async () => {
    stubFetch(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    await expect(downloadFreshworksImage(FRESHDESK)).rejects.toThrow(/did not answer in \d+s/);
  });
});
