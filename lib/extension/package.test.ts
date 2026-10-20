import { describe, expect, it } from 'vitest';
import { installPolicy, updateManifest, updatesUrl } from './package';

const PKG = {
  id: 'phjkopilmgnpibkccmplnpplpccmedfb',
  version: '0.1.0',
  origin: 'https://shipblu-support.onrender.com',
};

describe('updateManifest', () => {
  it('names the package, its version and where to download it, as Chrome reads them', () => {
    expect(updateManifest(PKG)).toBe(
      [
        "<?xml version='1.0' encoding='UTF-8'?>",
        "<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>",
        "  <app appid='phjkopilmgnpibkccmplnpplpccmedfb'>",
        "    <updatecheck codebase='https://shipblu-support.onrender.com/api/extension/package/shipblu-support.crx' version='0.1.0' />",
        '  </app>',
        '</gupdate>',
        '',
      ].join('\n'),
    );
  });
});

describe('installPolicy', () => {
  it('force-installs and pins the package, with updates from the console', () => {
    expect(installPolicy(PKG)).toEqual({
      ExtensionSettings: {
        phjkopilmgnpibkccmplnpplpccmedfb: {
          installation_mode: 'force_installed',
          update_url: 'https://shipblu-support.onrender.com/api/extension/package/updates.xml',
          override_update_url: true,
          toolbar_pin: 'force_pinned',
        },
      },
    });
    expect(updatesUrl(PKG)).toBe(installPolicy(PKG).ExtensionSettings[PKG.id]!.update_url);
  });
});
