/**
 * The tab-aware side panel: page strip, Manager scope, active tab events,
 * the external-mode picker with follow, and the Modify chip.
 */
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { SidebarRequest, SidebarResponseFor } from '@sitecraft/shared';
import {
  FakeBridge,
  allByTestId,
  buttonByText,
  byTestId,
  cardIds,
  cleanup,
  click,
  emitActiveTab,
  flush,
  installBrokenWindow,
  installWindow,
  mount,
  queryTestId,
  script,
  tabA,
  tabB,
  text,
  type,
} from './ui.fakes';

afterEach(cleanup);

const youtubeHome = { ...tabA, url: 'https://www.youtube.com/', title: 'YouTube' };

/** Three scripts: two match youtube (s3 first by priority), one matches example.com. */
function threeScripts() {
  return [
    script(),
    script({ id: 's2', name: 'Big comments', urlPattern: 'https://example.com/*', kind: 'js', priority: 1, trial: false }),
    script({ id: 's3', name: 'Zed', urlPattern: '*://*.youtube.com/*', priority: 1 }),
  ];
}

function managerLabel(): string {
  return byTestId('tab-manager').textContent?.trim() ?? '';
}

/** A bridge whose getActiveTab answer waits until release() is called. */
class HeldBridge extends FakeBridge {
  private held: (() => void) | null = null;

  override request<R extends SidebarRequest>(req: R): Promise<SidebarResponseFor<R>> {
    const answer = super.request(req);
    if (req.type !== 'getActiveTab') return answer;
    return new Promise<SidebarResponseFor<R>>((resolve) => {
      this.held = () => resolve(answer);
    });
  }

  release(): void {
    this.held?.();
    this.held = null;
  }
}

describe('page strip', () => {
  it('shows the host in bold and the title truncated to 60 characters', async () => {
    const longTitle = 'T'.repeat(80);
    const bridge = new FakeBridge({ activeTab: { ...tabA, title: longTitle } });
    await mount(bridge);
    const strip = byTestId('page-strip');
    expect(strip.querySelector('.page-host')?.textContent).toBe('www.youtube.com');
    expect(strip.querySelector('.page-title')?.textContent).toBe(`${'T'.repeat(57)}...`);
    expect(strip.getAttribute('title')).toBe(longTitle);
  });

  it('falls back to the URL when the title is blank', async () => {
    const bridge = new FakeBridge({ activeTab: { ...tabB, title: '  ' } });
    await mount(bridge);
    expect(byTestId('page-strip').querySelector('.page-title')?.textContent).toBe('https://example.com/');
  });

  it('says when no web page is active', async () => {
    const bridge = new FakeBridge({ activeTab: null });
    await mount(bridge);
    expect(byTestId('page-strip').textContent).toBe('No web page is active. Open a site in this window.');
  });

  it('asks for the active tab of its own window when chrome.windows is available', async () => {
    installWindow(7);
    const bridge = new FakeBridge();
    await mount(bridge);
    expect(bridge.callsOf('getActiveTab')).toEqual([{ type: 'getActiveTab', windowId: 7 }]);
  });

  it('treats a failing chrome.windows.getCurrent as an unknown window', async () => {
    installBrokenWindow();
    const bridge = new FakeBridge();
    await mount(bridge);
    expect(bridge.callsOf('getActiveTab')).toEqual([{ type: 'getActiveTab' }]);
    expect(byTestId('page-strip').textContent).toContain('www.youtube.com');
  });

  it('falls back to getDefaultTab when getActiveTab is unknown (old background during update)', async () => {
    const bridge = new FakeBridge({ failing: ['getActiveTab'], errors: { getActiveTab: 'Unknown request type: getActiveTab' } });
    installWindow(3);
    await mount(bridge);
    // getDefaultTab answers with the first tab, so the panel still targets it.
    expect(bridge.callsOf('getDefaultTab').length).toBeGreaterThan(0);
    expect(byTestId('page-strip').textContent).toContain('www.youtube.com');
    expect(byTestId<HTMLTextAreaElement>('chat-input').disabled).toBe(false);
  });

  it('shows no page when both getActiveTab and getDefaultTab reject', async () => {
    const bridge = new FakeBridge({ failing: ['getActiveTab', 'getDefaultTab'] });
    await mount(bridge);
    expect(byTestId('page-strip').textContent).toContain('No web page is active.');
    expect(byTestId<HTMLTextAreaElement>('chat-input').disabled).toBe(true);
  });
});

describe('resync in extension mode', () => {
  it('asks for the active tab again on Retry', async () => {
    const bridge = new FakeBridge({ failing: ['getState', 'getActiveTab'] });
    await mount(bridge);
    expect(bridge.callsOf('getActiveTab')).toHaveLength(1);

    bridge.failing.clear();
    await click(buttonByText('Retry'));
    expect(bridge.callsOf('getState')).toHaveLength(2);
    expect(bridge.callsOf('getActiveTab')).toHaveLength(2);
    expect(byTestId('page-strip').textContent).toContain('www.youtube.com');
    expect(byTestId<HTMLTextAreaElement>('chat-input').disabled).toBe(false);
  });

  it('drops a Retry answer when an event arrived while it was in flight', async () => {
    installWindow(1);
    const bridge = new HeldBridge({ failing: ['getState'] });
    await mount(bridge);
    await act(async () => {
      bridge.release();
    });
    await flush();

    bridge.failing.clear();
    await click(buttonByText('Retry'));
    expect(bridge.callsOf('getActiveTab')).toHaveLength(2);
    expect(byTestId('page-strip').textContent).toContain('www.youtube.com');

    await emitActiveTab(bridge, 1, tabB);
    expect(byTestId('page-strip').textContent).toContain('example.com');

    // The held answer (tabA) is older than the event. It must not win.
    await act(async () => {
      bridge.release();
    });
    await flush();
    expect(byTestId('page-strip').textContent).toContain('example.com');
    expect(byTestId('page-strip').textContent).not.toContain('www.youtube.com');
  });

  it('applies a sync event for its window, as sent when the port attaches', async () => {
    installWindow(1);
    const bridge = new FakeBridge({ activeTab: null });
    await mount(bridge);
    expect(byTestId('page-strip').textContent).toContain('No web page is active.');

    await emitActiveTab(bridge, 2, tabB, 'sync');
    expect(byTestId('page-strip').textContent).toContain('No web page is active.');

    await emitActiveTab(bridge, 1, tabA, 'sync');
    expect(byTestId('page-strip').textContent).toContain('www.youtube.com');
    expect(byTestId<HTMLTextAreaElement>('chat-input').disabled).toBe(false);
  });
});

describe('Manager scope', () => {
  it('defaults to the page scope with matching scripts sorted by priority, and All sites keeps host groups', async () => {
    const bridge = new FakeBridge({ scripts: threeScripts() });
    await mount(bridge);
    await click(byTestId('tab-manager'));

    const pageBtn = byTestId('scope-page');
    const allBtn = byTestId('scope-all');
    expect(pageBtn.getAttribute('aria-pressed')).toBe('true');
    expect(allBtn.getAttribute('aria-pressed')).toBe('false');
    expect(cardIds()).toEqual(['s3', 's1']);
    expect(allByTestId('script-group')).toHaveLength(0);
    expect(byTestId('manager-count').textContent).toBe('2 scripts');

    await click(allBtn);
    expect(pageBtn.getAttribute('aria-pressed')).toBe('false');
    expect(allBtn.getAttribute('aria-pressed')).toBe('true');
    // Groups sort by host label, so the *.youtube.com group comes first.
    expect(cardIds()).toEqual(['s3', 's2', 's1']);
    const hosts = allByTestId('script-group').map((g) => g.getAttribute('data-host'));
    expect(hosts).toEqual(['*.youtube.com', 'example.com', 'www.youtube.com']);
    expect(byTestId('manager-count').textContent).toBe('3 scripts');

    await click(pageBtn);
    expect(cardIds()).toEqual(['s3', 's1']);
  });

  it('shows the page empty text with the host, and the no-page text without a page', async () => {
    const bridge = new FakeBridge({ scripts: [script({ urlPattern: 'https://example.com/*' })] });
    await mount(bridge);
    await click(byTestId('tab-manager'));
    expect(byTestId('manager-empty').textContent).toBe('No scripts for www.youtube.com yet. Ask for a change in Chat.');
    expect(byTestId('manager-count').textContent).toBe('0 scripts');

    await emitActiveTab(bridge, 1, null);
    expect(byTestId('manager-empty').textContent).toBe('No web page is active. Switch to All sites to see every script.');

    await click(byTestId('scope-all'));
    expect(queryTestId('manager-empty')).toBeNull();
    expect(cardIds()).toEqual(['s1']);
  });

  it('keeps the All sites empty text when there are no scripts at all', async () => {
    const bridge = new FakeBridge({ activeTab: null });
    await mount(bridge);
    await click(byTestId('tab-manager'));
    await click(byTestId('scope-all'));
    expect(byTestId('manager-empty').textContent).toBe('No scripts yet. Ask for a change in Chat.');
  });

  it('keeps an open editor and its draft when the page changes and comes back', async () => {
    installWindow(1);
    const bridge = new FakeBridge({ scripts: threeScripts() });
    await mount(bridge);
    await click(byTestId('tab-manager'));
    expect(cardIds()).toEqual(['s3', 's1']);
    await click(allByTestId('script-edit')[1]!);
    await type(byTestId<HTMLTextAreaElement>('script-code'), '#promo-banner { display: none }');

    // The user checks another tab. The card leaves the page scope.
    await emitActiveTab(bridge, 1, tabB);
    expect(cardIds()).toEqual(['s2']);
    expect(queryTestId('script-code')).toBeNull();

    // Back on the page, the editor is still open with the draft.
    await emitActiveTab(bridge, 1, tabA);
    expect(cardIds()).toEqual(['s3', 's1']);
    const editor = byTestId<HTMLTextAreaElement>('script-code');
    expect(editor.closest('[data-script-id]')?.getAttribute('data-script-id')).toBe('s1');
    expect(editor.value).toBe('#promo-banner { display: none }');

    await click(byTestId('script-save'));
    expect(bridge.callsOf('updateCode')).toEqual([{ type: 'updateCode', id: 's1', code: '#promo-banner { display: none }' }]);
    expect(queryTestId('script-code')).toBeNull();
  });

  it('keeps an open editor and a pending delete across a scope round trip', async () => {
    const bridge = new FakeBridge({ scripts: threeScripts() });
    await mount(bridge);
    await click(byTestId('tab-manager'));
    await click(allByTestId('script-edit')[1]!);
    await type(byTestId<HTMLTextAreaElement>('script-code'), 'draft');
    await click(allByTestId('script-delete')[0]!);
    expect(byTestId('script-delete-confirm')).toBeTruthy();

    await click(byTestId('scope-all'));
    expect(cardIds()).toEqual(['s3', 's2', 's1']);
    expect(byTestId<HTMLTextAreaElement>('script-code').value).toBe('draft');
    expect(byTestId('script-delete-confirm').closest('[data-script-id]')?.getAttribute('data-script-id')).toBe('s3');

    await click(byTestId('scope-page'));
    expect(byTestId<HTMLTextAreaElement>('script-code').value).toBe('draft');

    await click(byTestId('script-cancel-edit'));
    expect(queryTestId('script-code')).toBeNull();
    await click(byTestId('script-delete-cancel'));
    expect(queryTestId('script-delete-confirm')).toBeNull();
  });

  it('counts the scripts that match the page in the Manager tab label', async () => {
    const bridge = new FakeBridge({ scripts: threeScripts() });
    await mount(bridge);
    expect(managerLabel()).toBe('Manager (2)');

    await emitActiveTab(bridge, 1, tabB);
    expect(managerLabel()).toBe('Manager (1)');

    await emitActiveTab(bridge, 1, { ...tabB, url: 'https://nothing.test/' });
    expect(managerLabel()).toBe('Manager');

    await emitActiveTab(bridge, 1, null);
    expect(managerLabel()).toBe('Manager');
  });
});

describe('active tab events in extension mode', () => {
  it('applies an event for its own window to the strip, the list, and the composer target', async () => {
    installWindow(1);
    const bridge = new FakeBridge({ scripts: threeScripts() });
    await mount(bridge);
    await click(byTestId('tab-manager'));
    expect(cardIds()).toEqual(['s3', 's1']);

    await emitActiveTab(bridge, 1, tabB);
    expect(byTestId('page-strip').textContent).toContain('example.com');
    expect(byTestId('page-strip').textContent).toContain('Example');
    expect(cardIds()).toEqual(['s2']);

    await click(byTestId('tab-chat'));
    await type(byTestId<HTMLTextAreaElement>('chat-input'), 'Bigger text');
    await click(byTestId('chat-send'));
    expect(bridge.callsOf('runRequest')).toEqual([{ type: 'runRequest', tabId: 12, text: 'Bigger text' }]);
  });

  it('keeps an event that arrives before the getActiveTab answer', async () => {
    installWindow(1);
    const bridge = new HeldBridge({ scripts: threeScripts() });
    await mount(bridge);
    expect(bridge.callsOf('getActiveTab')).toHaveLength(1);
    expect(byTestId('page-strip').textContent).toBe('');

    await emitActiveTab(bridge, 1, tabB);
    expect(byTestId('page-strip').textContent).toContain('example.com');

    // The answer (tabA) is older than the event. It must not win.
    await act(async () => {
      bridge.release();
    });
    await flush();
    expect(byTestId('page-strip').textContent).toContain('example.com');
    expect(byTestId('page-strip').textContent).not.toContain('www.youtube.com');
    expect(managerLabel()).toBe('Manager (1)');
  });

  it('applies the getActiveTab answer when no event came first', async () => {
    installWindow(1);
    const bridge = new HeldBridge();
    await mount(bridge);
    expect(byTestId('page-strip').textContent).toBe('');
    expect(byTestId<HTMLTextAreaElement>('chat-input').disabled).toBe(true);
    expect(queryTestId('no-page-hint')).toBeNull();

    await act(async () => {
      bridge.release();
    });
    await flush();
    expect(byTestId('page-strip').textContent).toContain('www.youtube.com');
    expect(byTestId<HTMLTextAreaElement>('chat-input').disabled).toBe(false);
  });

  it('ignores an event for another window', async () => {
    installWindow(1);
    const bridge = new FakeBridge({ scripts: threeScripts() });
    await mount(bridge);
    await emitActiveTab(bridge, 2, tabB);
    expect(byTestId('page-strip').textContent).toContain('www.youtube.com');
    expect(byTestId('page-strip').textContent).not.toContain('example.com');
    expect(managerLabel()).toBe('Manager (2)');
  });

  it('applies every event when the window id is unknown', async () => {
    const bridge = new FakeBridge();
    await mount(bridge);
    await emitActiveTab(bridge, 42, tabB);
    expect(byTestId('page-strip').textContent).toContain('example.com');
  });

  it('disables the composer and shows the hint when the page goes away, then restores it', async () => {
    installWindow(1);
    const bridge = new FakeBridge({ activeTab: null });
    await mount(bridge);
    expect(byTestId<HTMLTextAreaElement>('chat-input').disabled).toBe(true);
    expect(byTestId<HTMLButtonElement>('chat-send').disabled).toBe(true);
    expect(byTestId('no-page-hint').textContent).toBe('Open a website in this window to make changes.');

    await emitActiveTab(bridge, 1, tabA);
    expect(byTestId<HTMLTextAreaElement>('chat-input').disabled).toBe(false);
    expect(byTestId<HTMLButtonElement>('chat-send').disabled).toBe(false);
    expect(queryTestId('no-page-hint')).toBeNull();
    expect(text()).toContain('Enter sends.');

    await emitActiveTab(bridge, 1, null);
    expect(byTestId<HTMLTextAreaElement>('chat-input').disabled).toBe(true);
    expect(byTestId('no-page-hint')).toBeTruthy();
  });
});

describe('external mode', () => {
  it('shows the picker and the follow checkbox and picks the default tab', async () => {
    const bridge = new FakeBridge({ mode: 'external' });
    await mount(bridge);
    const picker = byTestId<HTMLSelectElement>('tab-picker');
    expect(picker.options.length).toBe(2);
    expect(picker.value).toBe('11');
    expect(byTestId<HTMLInputElement>('follow-active').checked).toBe(true);
    expect(byTestId('page-strip').textContent).toContain('www.youtube.com');
    expect(bridge.callsOf('getActiveTab')).toHaveLength(0);
    expect(bridge.callsOf('listTabs')).toHaveLength(1);
    expect(bridge.callsOf('getDefaultTab')).toHaveLength(1);
  });

  it('follows events from other origins and ignores the harness origin and null tabs', async () => {
    const bridge = new FakeBridge({ mode: 'external' });
    await mount(bridge);

    await emitActiveTab(bridge, 1, { ...tabB, tabId: 99, url: `${location.origin}/harness/`, title: 'Sitecraft Harness' });
    expect(byTestId('page-strip').textContent).toContain('www.youtube.com');
    expect(byTestId<HTMLSelectElement>('tab-picker').options.length).toBe(2);

    await emitActiveTab(bridge, 1, null);
    expect(byTestId('page-strip').textContent).toContain('www.youtube.com');

    await emitActiveTab(bridge, 3, tabB);
    expect(byTestId('page-strip').textContent).toContain('example.com');
    expect(byTestId<HTMLSelectElement>('tab-picker').value).toBe('12');

    // A tab that is not in the list yet joins the picker.
    const tabC = { tabId: 13, windowId: 3, url: 'https://news.test/', title: 'News', active: true };
    await emitActiveTab(bridge, 3, tabC);
    expect(byTestId('page-strip').textContent).toContain('news.test');
    const picker = byTestId<HTMLSelectElement>('tab-picker');
    expect(picker.options.length).toBe(3);
    expect(picker.value).toBe('13');
  });

  it('does not move the target on an update in another window, but refreshes the target on its own update', async () => {
    const bridge = new FakeBridge({ mode: 'external' });
    await mount(bridge);
    expect(byTestId('page-strip').textContent).toContain('www.youtube.com');

    // A title tick on the active tab of a background window.
    const inbox = { tabId: 30, windowId: 2, url: 'https://mail.test/', title: 'Inbox (3)', active: true };
    await emitActiveTab(bridge, 2, inbox, 'updated');
    expect(byTestId('page-strip').textContent).toContain('www.youtube.com');
    expect(byTestId<HTMLSelectElement>('tab-picker').value).toBe('11');
    // It still joins the picker.
    expect(byTestId<HTMLSelectElement>('tab-picker').options.length).toBe(3);

    // The target itself navigates. The strip follows and the target stays.
    await emitActiveTab(bridge, 1, { ...tabA, url: 'https://www.youtube.com/feed/subscriptions', title: 'Subscriptions' }, 'updated');
    expect(byTestId('page-strip').textContent).toContain('Subscriptions');
    expect(byTestId<HTMLSelectElement>('tab-picker').value).toBe('11');

    // A tab switch in another window still moves the target.
    await emitActiveTab(bridge, 2, inbox, 'activated');
    expect(byTestId('page-strip').textContent).toContain('mail.test');
    expect(byTestId<HTMLSelectElement>('tab-picker').value).toBe('30');
  });

  it('refreshes a hand-picked target on its own update while follow is off', async () => {
    const bridge = new FakeBridge({ mode: 'external' });
    await mount(bridge);
    await type(byTestId<HTMLSelectElement>('tab-picker'), '12');
    expect(byTestId<HTMLInputElement>('follow-active').checked).toBe(false);

    await emitActiveTab(bridge, 1, { ...tabB, title: 'Example, renamed' }, 'updated');
    expect(byTestId('page-strip').textContent).toContain('Example, renamed');
    expect(byTestId<HTMLSelectElement>('tab-picker').value).toBe('12');

    await emitActiveTab(bridge, 1, tabA, 'activated');
    expect(byTestId('page-strip').textContent).toContain('example.com');
  });

  it('turns follow off on a manual pick and back on through the checkbox', async () => {
    const bridge = new FakeBridge({ mode: 'external' });
    await mount(bridge);
    await type(byTestId<HTMLSelectElement>('tab-picker'), '12');
    expect(byTestId<HTMLInputElement>('follow-active').checked).toBe(false);
    expect(byTestId('page-strip').textContent).toContain('example.com');

    await emitActiveTab(bridge, 1, tabA);
    expect(byTestId('page-strip').textContent).toContain('example.com');

    await type(byTestId<HTMLTextAreaElement>('chat-input'), 'Hide the promo banner');
    await click(byTestId('chat-send'));
    expect(bridge.callsOf('runRequest')).toEqual([{ type: 'runRequest', tabId: 12, text: 'Hide the promo banner' }]);

    await click(byTestId('follow-active'));
    expect(byTestId<HTMLInputElement>('follow-active').checked).toBe(true);
    await emitActiveTab(bridge, 1, tabA);
    expect(byTestId('page-strip').textContent).toContain('www.youtube.com');
  });

  it('reloads the tab list on Refresh and keeps the current pick', async () => {
    const bridge = new FakeBridge({ mode: 'external' });
    await mount(bridge);
    await type(byTestId<HTMLSelectElement>('tab-picker'), '12');
    bridge.tabs = [tabB, { ...tabA, title: 'Renamed' }];
    await click(byTestId('tab-refresh'));
    expect(bridge.callsOf('listTabs')).toHaveLength(2);
    expect(byTestId<HTMLSelectElement>('tab-picker').value).toBe('12');
    expect(byTestId('page-strip').textContent).toContain('example.com');
  });

  it('falls back to the default tab when the picked tab is gone', async () => {
    const bridge = new FakeBridge({ mode: 'external' });
    await mount(bridge);
    await type(byTestId<HTMLSelectElement>('tab-picker'), '12');
    bridge.tabs = [tabA];
    await click(byTestId('tab-refresh'));
    expect(byTestId<HTMLSelectElement>('tab-picker').value).toBe('11');
  });

  it('has a Reload extension link that sends devReload and ignores a disconnect', async () => {
    const bridge = new FakeBridge({ mode: 'external' });
    await mount(bridge);
    await click(byTestId('dev-reload'));
    expect(bridge.callsOf('devReload')).toEqual([{ type: 'devReload' }]);
    expect(queryTestId('footer-error')).toBeNull();

    // The worker restarts before it can answer. That is the normal case.
    await cleanup();
    const dropped = new FakeBridge({
      mode: 'external',
      failing: ['devReload'],
      errors: { devReload: 'Disconnected: The message port closed before a response was received.' },
    });
    await mount(dropped);
    await click(byTestId('dev-reload'));
    expect(dropped.callsOf('devReload')).toEqual([{ type: 'devReload' }]);
    expect(queryTestId('footer-error')).toBeNull();
    expect(byTestId('chat-input')).toBeTruthy();
  });

  it('shows a devReload error that is not a disconnect in the footer', async () => {
    const bridge = new FakeBridge({ mode: 'external', failing: ['devReload'], errors: { devReload: 'Not available in this build.' } });
    await mount(bridge);
    await click(byTestId('dev-reload'));
    expect(byTestId('footer-error').textContent).toBe('Not available in this build.');

    // The next click clears it.
    bridge.failing.clear();
    await click(byTestId('dev-reload'));
    expect(queryTestId('footer-error')).toBeNull();
  });
});

describe('Modify chip', () => {
  it('clears when the page no longer matches the target script and survives a same-site navigation', async () => {
    installWindow(1);
    const bridge = new FakeBridge({ scripts: [script()] });
    await mount(bridge);
    await click(byTestId('tab-manager'));
    await click(byTestId('script-modify'));
    expect(byTestId('modify-chip').textContent).toContain('Modifying: Hide promo banner');

    await emitActiveTab(bridge, 1, youtubeHome);
    expect(queryTestId('modify-chip')).not.toBeNull();

    await emitActiveTab(bridge, 2, tabB);
    expect(queryTestId('modify-chip')).not.toBeNull();

    await emitActiveTab(bridge, 1, tabB);
    expect(queryTestId('modify-chip')).toBeNull();
  });

  it('stays when picked from All sites for another host until the page changes', async () => {
    const bridge = new FakeBridge({ scripts: [script({ urlPattern: 'https://example.com/*' })] });
    await mount(bridge);
    await click(byTestId('tab-manager'));
    await click(byTestId('scope-all'));
    await click(byTestId('script-modify'));
    expect(queryTestId('modify-chip')).not.toBeNull();

    await emitActiveTab(bridge, 1, youtubeHome);
    expect(queryTestId('modify-chip')).toBeNull();
  });
});
