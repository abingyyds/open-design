import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PreviewModal } from '../../src/components/PreviewModal';
import { HostedPlatformContext } from '../../src/providers/platform';

describe('PreviewModal sandbox isolation', () => {
  it('uses hosted CSP and disallows popups in the shared HTML modal', () => {
    const markup = renderToStaticMarkup(
      <HostedPlatformContext.Provider value={true}>
        <PreviewModal title="Kit" views={[{ id: 'preview', label: 'Preview', html: '<h1>Fixture</h1>' }]}
          exportTitleFor={() => 'kit-preview'} onClose={() => {}} />
      </HostedPlatformContext.Provider>,
    );
    expect(markup).toContain('sandbox="allow-scripts"');
    expect(markup).toContain('connect-src &#x27;none&#x27;');
    expect(markup).not.toContain('allow-popups-to-escape-sandbox');
  });
  it('renders generated previews without same-origin sandbox access', () => {
    const markup = renderToStaticMarkup(
      <PreviewModal
        title="Unsafe preview"
        views={[
          {
            id: 'preview',
            label: 'Preview',
            html: '<script>window.parent.document.body.innerHTML="owned"</script>',
          },
        ]}
        exportTitleFor={() => 'unsafe-preview'}
        onClose={() => {}}
      />,
    );

    expect(markup).toContain('sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"');
    expect(markup).not.toContain('allow-same-origin');
    expect(markup).toContain('srcDoc=');
  });

  it('keeps deck srcdoc handling for deck preview views', () => {
    const markup = renderToStaticMarkup(
      <PreviewModal
        title="Deck preview"
        views={[
          {
            id: 'deck',
            label: 'Deck',
            html: '<section class="slide">one</section><section class="slide">two</section>',
            deck: true,
          },
        ]}
        exportTitleFor={() => 'deck-preview'}
        onClose={() => {}}
      />,
    );

    expect(markup).toContain('sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"');
    expect(markup).not.toContain('allow-same-origin');
    expect(markup).toContain('od:slide');
  });

  it('includes popup flags in the sandbox attribute', () => {
    const markup = renderToStaticMarkup(
      <PreviewModal
        title="Popup preview"
        views={[
          {
            id: 'popup',
            label: 'Popup',
            html: '<button onclick="window.open(\'https://example.com\')">Open Popup</button>',
          },
        ]}
        exportTitleFor={() => 'popup-preview'}
        onClose={() => {}}
      />,
    );

    expect(markup).toContain('allow-popups');
    expect(markup).toContain('allow-popups-to-escape-sandbox');
  });
});
