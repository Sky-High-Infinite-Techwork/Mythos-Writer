import { describe, expect, it, vi } from 'vitest';
import {
  PARTNER_QUICK_COMMANDS,
  archiveContinuityEnabledFromSettings,
  resolveQuickCommandPrompt,
  runPartnerQuickCommand,
} from './partnerQuickCommands';
import type { Scene, Story } from '../types';

const story: Story = {
  id: 'st1',
  title: 'Story',
  path: 'Manuscript/Story',
  chapters: [{
    id: 'ch1',
    title: 'Ch1',
    order: 0,
    path: 'ch1',
    createdAt: '',
    updatedAt: '',
    scenes: [{
      id: 'sc1',
      title: 'Scene',
      order: 0,
      blocks: [{ id: 'b1', type: 'prose', content: 'Prose here.', order: 0 }],
      path: 'sc.md',
    } as Scene],
  }],
  createdAt: '',
  updatedAt: '',
};

describe('PARTNER_QUICK_COMMANDS (FD-4)', () => {
  it('ships the four v2.6 quick-command labels', () => {
    expect(PARTNER_QUICK_COMMANDS.map((c) => c.label)).toEqual([
      'Beta read',
      'Continuity',
      'Notes→timeline',
      'Timeline→notes',
    ]);
  });
});

describe('resolveQuickCommandPrompt', () => {
  it('uses advanced override when set (60:50)', () => {
    const custom = 'Custom structure prompt';
    expect(resolveQuickCommandPrompt('timeline-to-notes', { 'timeline-to-notes': custom })).toBe(custom);
  });

  it('returns null for commands without a default prompt', () => {
    expect(resolveQuickCommandPrompt('continuity')).toBeNull();
  });

  it('ignores whitespace-only overrides', () => {
    expect(resolveQuickCommandPrompt('timeline-to-notes', { 'timeline-to-notes': '   ' })).toMatch(/timeline/i);
  });
});

function stubWindowApi(opts?: {
  settingsGet?: ReturnType<typeof vi.fn>;
  archiveScanContinuity?: ReturnType<typeof vi.fn>;
  enqueue?: ReturnType<typeof vi.fn>;
}) {
  const settingsGet = opts?.settingsGet ?? vi.fn().mockResolvedValue({
    archiveContinuityEnabled: true,
    agents: { archive: { enabled: true } },
  });
  const archiveScanContinuity = opts?.archiveScanContinuity
    ?? vi.fn().mockResolvedValue([]);
  const enqueue = opts?.enqueue ?? vi.fn().mockResolvedValue({});
  vi.stubGlobal('window', {
    api: {
      settingsGet,
      archiveScanContinuity,
      jobs: { enqueue },
    },
  });
  return { settingsGet, archiveScanContinuity, enqueue };
}

describe('archiveContinuityEnabledFromSettings', () => {
  it('matches ContinuityPanel gate', () => {
    expect(archiveContinuityEnabledFromSettings(null)).toBe(true);
    expect(archiveContinuityEnabledFromSettings({ archiveContinuityEnabled: true, agents: { archive: { enabled: true } } })).toBe(true);
    expect(archiveContinuityEnabledFromSettings({ archiveContinuityEnabled: false, agents: { archive: { enabled: true } } })).toBe(false);
    expect(archiveContinuityEnabledFromSettings({ archiveContinuityEnabled: true, agents: { archive: { enabled: false } } })).toBe(false);
  });
});

describe('runPartnerQuickCommand continuity', () => {
  const scene = story.chapters[0].scenes[0] as Scene;

  it('cards when no scene is open', async () => {
    const out = await runPartnerQuickCommand('continuity', { scene: null, story: null });
    expect(out.text).toMatch(/open a scene/i);
  });

  it('cards when scene has no prose', async () => {
    const emptyScene = { ...scene, blocks: [{ id: 'b1', type: 'prose', content: '  ', order: 0 }] } as Scene;
    const out = await runPartnerQuickCommand('continuity', { scene: emptyScene, story: null });
    expect(out.text).toMatch(/no prose/i);
  });

  it('cards when archive scan API is missing', async () => {
    vi.stubGlobal('window', { api: { settingsGet: vi.fn().mockResolvedValue({}) } });
    const out = await runPartnerQuickCommand('continuity', { scene, story: null });
    expect(out.text).toMatch(/unavailable/i);
  });

  it('starts continuity scan when archive continuity is enabled', async () => {
    const { archiveScanContinuity, enqueue } = stubWindowApi({});
    const out = await runPartnerQuickCommand('continuity', { scene, story: null });
    expect(out.kind).toBe('card');
    expect(out.text).toContain('started');
    expect(archiveScanContinuity).toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalled();
  });

  it('does not claim success when archive agent is disabled (M1)', async () => {
    const { archiveScanContinuity } = stubWindowApi({
      settingsGet: vi.fn().mockResolvedValue({
        archiveContinuityEnabled: true,
        agents: { archive: { enabled: false } },
      }),
    });
    const out = await runPartnerQuickCommand('continuity', { scene, story: null });
    expect(out.kind).toBe('card');
    expect(out.text).not.toMatch(/started/i);
    expect(out.text).toContain('Archive Agent is disabled');
    expect(archiveScanContinuity).not.toHaveBeenCalled();
  });

  it('does not claim success when continuity feature toggle is off', async () => {
    stubWindowApi({
      settingsGet: vi.fn().mockResolvedValue({
        archiveContinuityEnabled: false,
        agents: { archive: { enabled: true } },
      }),
    });
    const out = await runPartnerQuickCommand('continuity', { scene, story: null });
    expect(out.text).not.toMatch(/started/i);
    expect(out.text).toContain('Continuity checking is turned off');
  });

  it('starts scan even when jobs.enqueue is missing', async () => {
    vi.stubGlobal('window', {
      api: {
        settingsGet: vi.fn().mockResolvedValue({
          archiveContinuityEnabled: true,
          agents: { archive: { enabled: true } },
        }),
        archiveScanContinuity: vi.fn().mockResolvedValue([]),
      },
    });
    const out = await runPartnerQuickCommand('continuity', { scene, story: null });
    expect(out.text).toContain('started');
  });

  it('surfaces enqueue errors instead of success (M2)', async () => {
    stubWindowApi({
      enqueue: vi.fn().mockResolvedValue({ error: 'queue full' }),
    });
    const out = await runPartnerQuickCommand('continuity', { scene, story: null });
    expect(out.text).not.toMatch(/started/i);
    expect(out.text).toContain('queue full');
  });
});

describe('runPartnerQuickCommand beta-read', () => {
  const scene = story.chapters[0].scenes[0] as Scene;

  it('refuses when no story is open', async () => {
    vi.stubGlobal('window', {
      api: {
        settingsGet: vi.fn().mockResolvedValue({
          provider: { kind: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'sk-test' },
          agents: { betaReader: { enabled: true } },
        }),
        betaReportRun: vi.fn(),
      },
    });
    const out = await runPartnerQuickCommand('beta-read', { scene: null, story: null });
    expect(out.kind).toBe('card');
    expect(out.text).toMatch(/open a story/i);
  });

  it('falls back when beta report payload omits report body', async () => {
    vi.stubGlobal('window', {
      api: {
        settingsGet: vi.fn().mockResolvedValue({
          provider: { kind: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'sk-test' },
          agents: { betaReader: { enabled: true } },
        }),
        betaReportRun: vi.fn().mockResolvedValue({}),
      },
    });
    const out = await runPartnerQuickCommand('beta-read', { scene, story });
    expect(out.text).toMatch(/open Reports/i);
  });

  it('maps beta report API errors to a card', async () => {
    vi.stubGlobal('window', {
      api: {
        settingsGet: vi.fn().mockResolvedValue({
          provider: { kind: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'sk-test' },
          agents: { betaReader: { enabled: true } },
        }),
        betaReportRun: vi.fn().mockResolvedValue({ error: 'provider down' }),
      },
    });
    const out = await runPartnerQuickCommand('beta-read', { scene: story.chapters[0].scenes[0] as Scene, story });
    expect(out.text).toContain('provider down');
  });

  it('cards when betaReportRun is missing', async () => {
    vi.stubGlobal('window', {
      api: {
        settingsGet: vi.fn().mockResolvedValue({
          provider: { kind: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'sk-test' },
          agents: { betaReader: { enabled: true } },
        }),
      },
    });
    const out = await runPartnerQuickCommand('beta-read', { scene, story });
    expect(out.text).toMatch(/unavailable/i);
  });

  it('builds scene body when beta scope text is empty', async () => {
    vi.stubGlobal('window', {
      api: {
        settingsGet: vi.fn().mockResolvedValue({
          provider: { kind: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'sk-test' },
          agents: { betaReader: { enabled: true } },
        }),
        betaReportRun: vi.fn().mockResolvedValue({
          report: { overall: { verdict: 'ok', score: 1 }, feedback: 'Nice', categories: [] },
        }),
      },
    });
    const sceneOnly = story.chapters[0].scenes[0] as Scene;
    const out = await runPartnerQuickCommand('beta-read', { scene: sceneOnly, story });
    expect(out.text).toContain('Nice');
  });

  it('uses category verdicts when feedback is empty', async () => {
    vi.stubGlobal('window', {
      api: {
        settingsGet: vi.fn().mockResolvedValue({
          provider: { kind: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'sk-test' },
          agents: { betaReader: { enabled: true } },
        }),
        betaReportRun: vi.fn().mockResolvedValue({
          report: {
            overall: { verdict: 'mixed', score: 55 },
            feedback: '',
            categories: [{ label: 'Pace', verdict: 'slow' }],
          },
        }),
      },
    });
    const out = await runPartnerQuickCommand('beta-read', { scene, story });
    expect(out.text).toMatch(/Pace: slow/);
  });

  it('summarizes a successful beta report', async () => {
    vi.stubGlobal('window', {
      api: {
        settingsGet: vi.fn().mockResolvedValue({
          provider: { kind: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'sk-test' },
          agents: { betaReader: { enabled: true } },
        }),
        betaReportRun: vi.fn().mockResolvedValue({
          report: {
            overall: { verdict: 'solid', score: 82 },
            feedback: 'Pacing works.',
            categories: [{ label: 'Hook', verdict: 'strong' }],
          },
        }),
      },
    });
    const out = await runPartnerQuickCommand('beta-read', { scene: story.chapters[0].scenes[0] as Scene, story });
    expect(out.text).toContain('Pacing works.');
  });
});

describe('runPartnerQuickCommand notes-to-timeline', () => {
  it('cards when timeline rebuild API is missing', async () => {
    vi.stubGlobal('window', { api: {} });
    const out = await runPartnerQuickCommand('notes-to-timeline', { scene: null, story: null });
    expect(out.text).toMatch(/unavailable/i);
  });

  it('summarizes non-zero timeline changes', async () => {
    vi.stubGlobal('window', {
      api: {
        timelineRebuild: vi.fn().mockResolvedValue({
          ok: true,
          report: { eventsAdded: 2, eventsUpdated: 1, eventsRemoved: 0, scenesRead: 2 },
        }),
      },
    });
    const out = await runPartnerQuickCommand('notes-to-timeline', { scene: null, story: null });
    expect(out.text).toMatch(/Added 2/);
  });

  it('reports zero changes when rebuild already up to date', async () => {
    vi.stubGlobal('window', {
      api: {
        timelineRebuild: vi.fn().mockResolvedValue({
          ok: true,
          report: { eventsAdded: 0, eventsUpdated: 0, eventsRemoved: 0, scenesRead: 3 },
        }),
      },
    });
    const out = await runPartnerQuickCommand('notes-to-timeline', { scene: null, story: null });
    expect(out.text).toMatch(/already up to date/i);
  });

  it('accepts ok rebuild without a detailed report', async () => {
    vi.stubGlobal('window', {
      api: {
        timelineRebuild: vi.fn().mockResolvedValue({ ok: true }),
      },
    });
    const out = await runPartnerQuickCommand('notes-to-timeline', { scene: null, story: null });
    expect(out.text).toMatch(/updated from your notes/i);
  });

  it('surfaces rebuild failure reason', async () => {
    vi.stubGlobal('window', {
      api: {
        timelineRebuild: vi.fn().mockResolvedValue({ ok: false, reason: 'vault locked' }),
      },
    });
    const out = await runPartnerQuickCommand('notes-to-timeline', { scene: null, story: null });
    expect(out.text).toContain('vault locked');
  });
});

describe('runPartnerQuickCommand timeline-to-notes', () => {
  it('returns chat prompt with timeline digest', async () => {
    vi.stubGlobal('window', {
      api: {
        timelinesGetStore: vi.fn().mockResolvedValue({
          store: {
            timelines: [{ id: 'tl-story', name: 'Story timeline', kind: 'story' }],
            eras: [{ id: 'e1', timelineId: 'tl-story', name: 'Age One' }],
            spans: [],
            events: [{ id: 'ev1', timelineId: 'tl-story', name: 'Landing', summary: 'Ship docks' }],
          },
        }),
      },
    });
    const out = await runPartnerQuickCommand('timeline-to-notes', { scene: null, story: null });
    expect(out.kind).toBe('chat');
    expect(out.text).toMatch(/Landing/);
    expect(out.text).toMatch(/Age One/);
  });

  it('digest includes spans without rowId and untitled timeline', async () => {
    vi.stubGlobal('window', {
      api: {
        timelinesGetStore: vi.fn().mockResolvedValue({
          store: {
            timelines: [{ id: 'tl-story', name: '', kind: 'story' }],
            eras: [],
            spans: [{ id: 'sp1', timelineId: 'tl-story', name: 'Act I' }],
            events: [{ id: 'ev1', timelineId: 'tl-story', name: 'Beat', summary: '' }],
          },
        }),
      },
    });
    const out = await runPartnerQuickCommand('timeline-to-notes', { scene: null, story: null, promptOverrides: { 'timeline-to-notes': 'Go' } });
    expect(out.kind).toBe('chat');
    expect(out.text).toMatch(/Timeline:/);
    expect(out.text).toMatch(/Act I/);
  });

  it('cards when timelinesGetStore throws', async () => {
    vi.stubGlobal('window', {
      api: {
        timelinesGetStore: vi.fn().mockRejectedValue(new Error('disk')),
      },
    });
    const out = await runPartnerQuickCommand('timeline-to-notes', { scene: null, story: null });
    expect(out.text).toMatch(/could not load/i);
  });

  it('cards when timelines API is missing', async () => {
    vi.stubGlobal('window', { api: {} });
    const out = await runPartnerQuickCommand('timeline-to-notes', { scene: null, story: null });
    expect(out.text).toMatch(/unavailable/i);
  });

  it('cards when no story timeline exists', async () => {
    vi.stubGlobal('window', {
      api: {
        timelinesGetStore: vi.fn().mockResolvedValue({
          store: { timelines: [], eras: [], spans: [], events: [] },
        }),
      },
    });
    const out = await runPartnerQuickCommand('timeline-to-notes', { scene: null, story: null });
    expect(out.kind).toBe('card');
    expect(out.text).toMatch(/no story timeline/i);
  });
});
