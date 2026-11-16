// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOSTED_PREVIEW_NAVIGATION_PARAM } from '@open-design/contracts';
import type { Brand } from '@open-design/contracts';

import { DesignKitView } from '../../src/components/DesignKitView';
import { I18nProvider } from '../../src/i18n';
import { brandToKit, parsedToKit, type DesignKit } from '../../src/runtime/design-kit';
import { parseDesignMd } from '../../src/runtime/design-md-parse';
import { HostedPlatformContext } from '../../src/providers/platform';

function previewKit(): DesignKit {
  return {
    designSystemId: 'user:preview-kit',
    name: 'Preview Kit',
    editable: true,
    canUpload: false,
    logoSrc: null,
    logoAlternates: [],
    colors: [{ role: 'Primary', name: 'Primary', hex: '#123456', usage: 'Primary actions' }],
    typography: {
      display: { family: 'Inter', fallbacks: [], weights: [700] },
      body: { family: 'Inter', fallbacks: [], weights: [400] },
    },
    fonts: [],
    system: {
      kitUrl: '/raw/projects/preview/system/kit.html',
    },
    assets: [{
      kind: 'landing',
      label: 'Landing page',
      url: '/raw/projects/preview/system/artifacts/landing.html',
    }],
    showcaseHtml: '<main><a target="_blank" href="/">Open</a></main>',
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('DesignKitView iframe sandboxing', () => {
  const brand: Brand = {
    name: 'Brand fixture',
    sourceUrl: '',
    tagline: '',
    description: '',
    colors: [],
    logo: { primary: null, alternates: [], notes: '' },
    typography: {
      display: { family: 'Inter', fallbacks: [], weights: [] },
      body: { family: 'Inter', fallbacks: [], weights: [] },
    },
    voice: { adjectives: [], tone: '', messagingPillars: [], vocabulary: { use: [], avoid: [] } },
    imagery: { style: '', subjects: [], treatment: '', avoid: [], samples: [] },
    layout: { radius: '', borderWeight: '', spacing: '', postureRules: [] },
  };
  it.each([
    {
      kind: 'project-backed',
      kit: brandToKit(brand, { editable: true, projectId: 'brand-preview' }),
      prefix: '/api/projects/brand-preview/preview-files',
    },
    {
      kind: 'packaged',
      kit: parsedToKit(parseDesignMd('# Packaged kit'), {
        editable: false, designSystemId: 'user:kit-fixture',
        packageInfo: { manifest: { id: 'kit-fixture', schemaVersion: 'fixture', name: 'Packaged kit', category: 'Fixture' } },
      }),
      prefix: '/api/design-systems/user%3Akit-fixture/preview-files',
    },
  ])('uses isolated file previews for the $kind kit and artifacts', ({ kit, prefix }) => {
    const { container } = render(
      <I18nProvider initial="en">
        <DesignKitView kit={kit} />
      </I18nProvider>,
    );
    expect(container.querySelector(`iframe[src="${prefix}/system/kit.html"]`)).toBeTruthy();
    expect(container.querySelector(`iframe[src="${prefix}/system/artifacts/landing.html"]`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    const dark = container.querySelector(`iframe[src="${prefix}/system/kit.dark.html"]`);
    expect(dark?.getAttribute('sandbox')).toBe('allow-scripts allow-popups');
  });

  it('does not let generated kit previews escape the iframe sandbox', () => {
    const { container } = render(
      <I18nProvider initial="en">
        <DesignKitView kit={previewKit()} />
      </I18nProvider>,
    );

    const iframes = Array.from(container.querySelectorAll('iframe'));
    expect(iframes.length).toBeGreaterThan(0);
    for (const iframe of iframes) {
      expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-popups');
    }
    expect(container.innerHTML).not.toContain('allow-popups-to-escape-sandbox');
    expect(container.innerHTML).not.toContain('allow-same-origin');
  });

  it('applies the hosted policy to inline and file-based kit previews', () => {
    const { container } = render(
      <HostedPlatformContext.Provider value={true}>
        <I18nProvider initial="en"><DesignKitView kit={previewKit()} /></I18nProvider>
      </HostedPlatformContext.Provider>,
    );
    const frames = Array.from(container.querySelectorAll('iframe'));
    expect(frames.some((frame) => frame.getAttribute('srcdoc')?.includes("connect-src 'none'"))).toBe(true);
    for (const frame of frames) expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
  });

  it('starts hosted kit and asset navigations only as their iframes enter view', () => {
    const observed = new Map<Element, (entries: { isIntersecting: boolean }[]) => void>();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(private readonly callback: (entries: { isIntersecting: boolean }[]) => void) {}
      observe(target: Element) { observed.set(target, this.callback); }
      disconnect() {}
    });
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const kit = brandToKit(brand, { editable: true, projectId: 'brand-preview' });
    try {
      const { container } = render(
        <HostedPlatformContext.Provider value={true}>
          <I18nProvider initial="en"><DesignKitView kit={kit} /></I18nProvider>
        </HostedPlatformContext.Provider>,
      );
      const kitFrame = container.querySelector('iframe[loading="lazy"]:not([aria-hidden])')!;
      const assetFrame = container.querySelector('iframe[aria-hidden="true"]')!;
      const frames = [kitFrame, assetFrame];
      for (const frame of frames) expect(frame).not.toBeNull();
      for (const frame of frames) expect(frame.getAttribute('src')).toBeNull();

      act(() => observed.get(kitFrame)!([{ isIntersecting: false }]));
      expect(kitFrame.getAttribute('src')).toBeNull();
      frames.forEach((frame, index) => {
        const visibleAt = now + (11 + index) * 60_000;
        clock.mockReturnValue(visibleAt);
        act(() => observed.get(frame)!([{ isIntersecting: true }]));
        const url = new URL(frame.getAttribute('src')!, window.location.origin);
        expect(url.pathname).toMatch(/^\/api\/projects\/brand-preview\/preview-files\//u);
        expect(url.searchParams.get(HOSTED_PREVIEW_NAVIGATION_PARAM)?.split('.')[0]).toBe(String(visibleAt));
        expect(frame.getAttribute('loading')).toBe('eager');
        expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
      });
    } finally {
      clock.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('renders new kit actions with the active non-English locale', () => {
    const kit = { ...previewKit(), canUpload: true };
    render(
      <I18nProvider initial="zh-CN">
        <DesignKitView
          kit={kit}
          designMd={{
            body: '# Preview Kit',
            onSave: async () => {},
            saving: false,
          }}
          onUploadModule={() => {}}
          onRefresh={() => {}}
        />
      </I18nProvider>,
    );

    expect(screen.getAllByTitle('复制 DESIGN.md').length).toBeGreaterThan(0);
    expect(screen.getByTitle('添加字体文件')).toBeTruthy();
    expect(screen.getByTitle('复制字体排版段落')).toBeTruthy();
    expect(screen.getByTitle('刷新')).toBeTruthy();
    expect(screen.queryByText('Add font file')).toBeNull();
    expect(screen.queryByText('Copy Typography section')).toBeNull();
    expect(screen.queryByText('Copy DESIGN.md')).toBeNull();
  });

  it('edits only the selected DESIGN.md module section', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <I18nProvider initial="en">
        <DesignKitView
          kit={previewKit()}
          designMd={{
            body: [
              '# Preview Kit',
              '',
              'The system overview.',
              '',
              '## Color Palette',
              '',
              '| Role | Name | Hex | Usage |',
              '| --- | --- | --- | --- |',
              '| primary | Primary | `#123456` | Primary actions |',
              '',
              '## Voice & Tone',
              '',
              '- Direct and clear.',
            ].join('\n'),
            onSave,
            saving: false,
          }}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTitle('Edit Palette section'));

    const textarea = screen.getByRole('textbox', { name: 'Palette DESIGN.md section' }) as HTMLTextAreaElement;
    expect(textarea.value).toContain('## Color Palette');
    expect(textarea.value).not.toContain('## Voice & Tone');

    fireEvent.change(textarea, {
      target: {
        value: [
          '## Color Palette',
          '',
          '| Role | Name | Hex | Usage |',
          '| --- | --- | --- | --- |',
          '| primary | Primary | `#FF6A3D` | Primary actions |',
        ].join('\n'),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save module' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0]?.[0] as string;
    expect(saved).toContain('# Preview Kit');
    expect(saved).toContain('## Voice & Tone');
    expect(saved).toContain('`#FF6A3D`');
    expect(saved).not.toContain('`#123456`');
  });

  it('keeps upload, full-system preview, and shortcut help out of the sticky more menu', () => {
    const baseKit = previewKit();
    const kit = {
      ...baseKit,
      canUpload: true,
      system: {
        kitUrl: baseKit.system!.kitUrl,
        kitDarkUrl: baseKit.system?.kitDarkUrl,
        tokensUrl: baseKit.system?.tokensUrl,
        indexUrl: '/raw/projects/preview/system/index.html',
      },
    };

    render(
      <I18nProvider initial="en">
        <DesignKitView
          kit={kit}
          stickyHeader
          designMd={{
            body: '# Preview Kit',
            onSave: async () => {},
            saving: false,
          }}
          onUploadModule={() => {}}
          onRefresh={() => {}}
        />
      </I18nProvider>,
    );

    expect(screen.queryByTestId('design-kit-shortcuts-hint')).toBeNull();

    fireEvent.click(screen.getByTestId('design-kit-more-actions'));

    expect(screen.getByRole('menuitem', { name: 'Edit DESIGN.md' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Copy DESIGN.md' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Upload MD' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Open full system' })).toBeNull();
  });

  it('renders sticky header action loading state in the overflow menu', () => {
    render(
      <I18nProvider initial="en">
        <DesignKitView
          kit={previewKit()}
          stickyHeader
          headerMenuActions={[
            {
              id: 'refresh',
              label: 'Refresh',
              icon: 'refresh',
              onClick: () => {},
              disabled: true,
              loading: true,
            },
          ]}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTestId('design-kit-more-actions'));
    const refresh = screen.getByRole('menuitem', { name: 'Refresh' });
    expect(refresh.getAttribute('aria-busy')).toBe('true');
    expect((refresh as HTMLButtonElement).disabled).toBe(true);
  });

  it('reports clipboard success for DESIGN.md copy actions', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const onActionFeedback = vi.fn();
    render(
      <I18nProvider initial="en">
        <DesignKitView
          kit={previewKit()}
          stickyHeader
          designMd={{ body: '# Preview Kit' }}
          onActionFeedback={onActionFeedback}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTestId('design-kit-more-actions'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy DESIGN.md' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('# Preview Kit'));
    expect(onActionFeedback).toHaveBeenCalledWith('loading', 'Copy DESIGN.md...');
    expect(onActionFeedback).toHaveBeenCalledWith('success', 'Copied!');
  });

  it('renders the embedded component kit without an Open full system action', () => {
    const baseKit = previewKit();
    const kit = {
      ...baseKit,
      system: {
        kitUrl: baseKit.system!.kitUrl,
        indexUrl: '/raw/projects/preview/system/index.html',
      },
    };

    const { container } = render(
      <I18nProvider initial="en">
        <DesignKitView kit={kit} />
      </I18nProvider>,
    );

    expect(screen.queryByRole('button', { name: 'Open full system' })).toBeNull();
    expect(container.querySelector('iframe[src="/raw/projects/preview/system/kit.html"]')).toBeTruthy();
  });

  it('opens the component kit on the light file before explicit dark selection', () => {
    const baseKit = previewKit();
    const kit = {
      ...baseKit,
      system: {
        kitUrl: baseKit.system!.kitUrl,
        kitDarkUrl: '/raw/projects/preview/system/kit.dark.html',
      },
    };

    const { container } = render(
      <I18nProvider initial="en">
        <DesignKitView kit={kit} />
      </I18nProvider>,
    );

    expect(container.querySelector('iframe[src="/raw/projects/preview/system/kit.html"]')).toBeTruthy();
    expect(container.querySelector('iframe[src="/raw/projects/preview/system/kit.dark.html"]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(container.querySelector('iframe[src="/raw/projects/preview/system/kit.dark.html"]')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(container.querySelector('iframe[src="/raw/projects/preview/system/kit.html"]')).toBeTruthy();
  });

  it('scrolls to Logo and reveals edit controls for edit focus requests', () => {
    vi.useFakeTimers();
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    const { container, unmount } = render(
      <I18nProvider initial="en">
        <DesignKitView
          kit={previewKit()}
          editFocusRequest={{ module: 'logo', nonce: 1 }}
        />
      </I18nProvider>,
    );

    try {
      const logoSection = container.querySelector<HTMLElement>('[data-testid="design-kit-logo-section"]');
      if (!logoSection) throw new Error('Expected Logo section to render');
      expect(logoSection.textContent).toContain(
        'Edit Logo here. Hover this section to reveal controls.',
      );
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
    } finally {
      unmount();
      vi.useRealTimers();
      if (originalScrollIntoView) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
          configurable: true,
          value: originalScrollIntoView,
        });
      } else {
        delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      }
    }
  });
});
