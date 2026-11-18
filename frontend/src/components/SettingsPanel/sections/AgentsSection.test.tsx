import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AgentsSection from './AgentsSection';
import type { AgentOverrideState, ModelListStatus } from '../settingsPanelTypes';
import { BETA_READER_DEFAULTS, DEFAULT_AGENT_OVERRIDE } from '../settingsPanelTypes';

type SetAgentField = React.ComponentProps<typeof AgentsSection>['setAgentField'];
type SetCategoryAutoApply = React.ComponentProps<typeof AgentsSection>['setCategoryAutoApply'];
type SetCategoryAutoApplyThreshold = React.ComponentProps<typeof AgentsSection>['setCategoryAutoApplyThreshold'];

const baseAgents = {
  writingAssistant: {
    enabled: true,
    model: '',
    scanIntervalSeconds: 30,
    autoApply: false,
    confidenceThreshold: 0.8,
    maxTokensPerHour: 10_000,
    maxSuggestionsPerHour: 20,
    heartbeatIntervalMinutes: 5,
    maxTokensPerDay: 500_000,
    cadenceTrigger: 'on_save' as const,
    idleHeartbeatConstantInterval: true,
    idleDebounceSeconds: 30,
  },
  brainstorm: {
    enabled: true,
    model: '',
    autoApply: false,
    confidenceThreshold: 0.8,
    maxTokensPerHour: 10_000,
    maxSuggestionsPerHour: 20,
    heartbeatIntervalMinutes: 5,
    maxTokensPerDay: 500_000,
    voiceEnabled: false,
  },
  archive: {
    enabled: true,
    model: '',
    continuityCheckIntervalSeconds: 60,
    autoApply: false,
    confidenceThreshold: 0.8,
    maxTokensPerHour: 10_000,
    maxSuggestionsPerHour: 20,
    heartbeatIntervalMinutes: 5,
    maxTokensPerDay: 500_000,
  },
  betaReader: BETA_READER_DEFAULTS,
};

const emptyOverrides: Record<'writingAssistant' | 'brainstorm' | 'archive' | 'betaReader', AgentOverrideState> = {
  writingAssistant: { ...DEFAULT_AGENT_OVERRIDE },
  brainstorm: { ...DEFAULT_AGENT_OVERRIDE },
  archive: { ...DEFAULT_AGENT_OVERRIDE },
  betaReader: { ...DEFAULT_AGENT_OVERRIDE },
};

const noopCategoryAutoApply = vi.fn() as SetCategoryAutoApply;
const noopCategoryThreshold = vi.fn() as SetCategoryAutoApplyThreshold;

type RenderSectionOpts = Partial<{
  settings: AppSettings;
  setAgentField: SetAgentField;
  setSettings: ReturnType<typeof vi.fn>;
  providerKind: 'ollama' | 'anthropic';
  modelListStatus: ModelListStatus;
  modelList: string[];
  agentOverrides: typeof emptyOverrides;
}>;

async function renderSection(overrides?: RenderSectionOpts) {
  const setAgentField: SetAgentField = overrides?.setAgentField ?? vi.fn() as SetAgentField;
  const setSettings = overrides?.setSettings ?? vi.fn((fn: (p: AppSettings) => AppSettings) => fn);
  const settings: AppSettings = overrides?.settings ?? {
    apiKey: '',
    theme: 'dark',
    agents: baseAgents,
    agentNames: {},
  } as AppSettings;

  const modelListStatus = overrides?.modelListStatus ?? 'ok';
  const view = render(
    <AgentsSection
      settings={settings}
      setSettings={setSettings as React.Dispatch<React.SetStateAction<AppSettings>>}
      providerKind={overrides?.providerKind ?? 'ollama'}
      providerModel="llama3"
      modelList={overrides?.modelList ?? ['llama3', 'mistral']}
      modelListStatus={modelListStatus}
      agentOverrides={overrides?.agentOverrides ?? emptyOverrides}
      agentTestStatus={{
        writingAssistant: 'idle',
        brainstorm: 'idle',
        archive: 'idle',
        betaReader: 'idle',
      }}
      agentTestMsg={{
        writingAssistant: '',
        brainstorm: '',
        archive: '',
        betaReader: '',
      }}
      setAgentField={setAgentField}
      setCategoryAutoApply={noopCategoryAutoApply}
      setCategoryAutoApplyThreshold={noopCategoryThreshold}
      setAgentOverride={vi.fn()}
      onAgentTest={vi.fn()}
      micDevices={[{ deviceId: 'mic1', label: 'USB Mic' }]}
      refreshMicDevices={vi.fn()}
      setAgentDisplayName={vi.fn()}
    />,
  );
  await waitFor(() => expect(screen.getByTestId('agent-index-controls')).toBeInTheDocument());
  return { setAgentField, setSettings, view };
}

describe('AgentsSection', () => {
  beforeEach(() => {
    (window as unknown as { api: Record<string, unknown> }).api = {
      agentIndex: {
        getStats: vi.fn().mockResolvedValue({
          entityCount: 2,
          lastScanAt: null,
          factDecisionCount: 0,
          cacheRowCount: 0,
        }),
        clean: vi.fn().mockResolvedValue({ tombstonesIntact: true, decisionsPreserved: 1 }),
        rebuild: vi.fn().mockResolvedValue({ jobId: 'job-1' }),
      },
      agentSessions: {
        list: vi.fn().mockResolvedValue({ sessions: [] }),
        read: vi.fn().mockResolvedValue({ session: { id: 's', agent: 'brainstorm', turns: [] } }),
      },
      brainstormGetSettings: vi.fn().mockResolvedValue({
        layoutMode: 'blank',
        notesRouting: { character: 'People/', location: undefined },
      }),
      brainstormResetCategoryRouting: vi.fn().mockResolvedValue({ notesRouting: {} }),
    };
  });

  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api;
  });

  it('renders agent duty chips for writing coach and brainstorm', async () => {
    await renderSection();
    expect(screen.getByTestId('agent-duties-writingAssistant')).toBeInTheDocument();
    expect(screen.getByTestId('agent-duties-brainstorm')).toBeInTheDocument();
  });

  it('Default model option tracks the global provider model for Ollama', async () => {
    const { setAgentField } = await renderSection();
    const waModel = screen.getByLabelText(/writing coach model/i) as HTMLSelectElement;
    expect(waModel.value).toBe('');
    expect(waModel.options[waModel.selectedIndex]?.text).toBe('Default (llama3)');
    fireEvent.change(waModel, { target: { value: 'mistral' } });
    expect(setAgentField).toHaveBeenCalledWith('writingAssistant', 'model', 'mistral');
  });

  it('disables auto-apply threshold slider when auto-apply is off', async () => {
    await renderSection();
    const slider = screen.getByLabelText(/writing coach auto-apply threshold/i);
    expect(slider).toBeDisabled();
  });

  it('enables auto-apply threshold slider when auto-apply is toggled on', async () => {
    const settings = {
      apiKey: '',
      theme: 'dark' as const,
      agents: {
        ...baseAgents,
        writingAssistant: { ...baseAgents.writingAssistant, autoApply: true },
      },
      agentNames: {},
    } as AppSettings;
    await renderSection({ settings });
    expect(screen.getByLabelText(/writing coach auto-apply threshold/i)).toBeEnabled();
  });

  it('fires setAgentField when writing coach enable toggle changes', async () => {
    const { setAgentField } = await renderSection();
    fireEvent.click(screen.getByRole('checkbox', { name: /enable writing coach/i }));
    expect(setAgentField).toHaveBeenCalledWith('writingAssistant', 'enabled', false);
  });

  it('brainstorm token caps and mic selection call setAgentField', async () => {
    const settings = {
      apiKey: '',
      theme: 'dark' as const,
      agents: {
        ...baseAgents,
        brainstorm: { ...baseAgents.brainstorm, voiceEnabled: true, micDeviceId: '' },
      },
      agentNames: {},
    } as AppSettings;
    const { setAgentField } = await renderSection({ settings });
    fireEvent.change(document.getElementById('brainstorm-max-tokens-day')!, { target: { value: '8000' } });
    expect(setAgentField).toHaveBeenCalledWith('brainstorm', 'maxTokensPerDay', 8000);
    fireEvent.change(document.getElementById('brainstorm-max-tokens')!, { target: { value: '7000' } });
    expect(setAgentField).toHaveBeenCalledWith('brainstorm', 'maxTokensPerHour', 7000);
    fireEvent.change(screen.getByLabelText(/brainstorm agent microphone/i), { target: { value: 'mic1' } });
    expect(setAgentField).toHaveBeenCalledWith('brainstorm', 'micDeviceId', 'mic1');
  });

  it('shows voice controls for brainstorm when voice is enabled', async () => {
    const settings = {
      apiKey: '',
      theme: 'dark' as const,
      agents: {
        ...baseAgents,
        brainstorm: { ...baseAgents.brainstorm, voiceEnabled: true },
      },
      agentNames: {},
    } as AppSettings;
    await renderSection({ settings });
    expect(screen.getByLabelText(/brainstorm agent voice/i)).toBeChecked();
    expect(screen.getByLabelText(/brainstorm agent microphone/i)).toBeInTheDocument();
  });

  it('index stats panel loads entity count from agentIndex.getStats', async () => {
    await renderSection();
    expect(await screen.findByText(/entities:/i)).toBeInTheDocument();
    expect(screen.getByText('2', { selector: 'strong' })).toBeInTheDocument();
  });

  it('queues rebuild index via agentIndex.rebuild', async () => {
    await renderSection();
    fireEvent.click(screen.getByRole('button', { name: /rebuild index/i }));
    expect(window.api?.agentIndex?.rebuild).toHaveBeenCalled();
    expect(await screen.findByText(/scan job queued/i)).toBeInTheDocument();
  });

  it('production role cards render alpha reader and line editor headings', async () => {
    await renderSection();
    expect(screen.getByText(/alpha reader/i)).toBeInTheDocument();
    expect(screen.getByText(/line editor/i)).toBeInTheDocument();
  });

  it('switches writing coach to idle heartbeat cadence branch', async () => {
    const { setAgentField } = await renderSection();
    fireEvent.click(screen.getByLabelText(/scan cadence: idle heartbeat/i));
    expect(setAgentField).toHaveBeenCalledWith('writingAssistant', 'cadenceTrigger', 'idle_heartbeat');
  });

  it('shows idle debounce controls when constant interval is off', async () => {
    const settings = {
      apiKey: '',
      theme: 'dark' as const,
      agents: {
        ...baseAgents,
        writingAssistant: {
          ...baseAgents.writingAssistant,
          cadenceTrigger: 'idle_heartbeat' as const,
          idleHeartbeatConstantInterval: false,
        },
      },
      agentNames: {},
    } as AppSettings;
    await renderSection({ settings });
    expect(screen.getByLabelText(/idle debounce/i)).toBeInTheDocument();
  });

  it('opens custom model input via Custom… option', async () => {
    await renderSection();
    const waModel = screen.getByLabelText(/writing coach model/i) as HTMLSelectElement;
    fireEvent.change(waModel, { target: { value: '__custom__' } });
    expect(screen.getByLabelText(/writing coach model/i).tagName).toBe('INPUT');
  });

  it('uses anthropic preset model list when global provider is anthropic', async () => {
    await renderSection({ providerKind: 'anthropic' });
    const waModel = screen.getByLabelText(/writing coach model/i) as HTMLSelectElement;
    expect(Array.from(waModel.options).some((o) => o.value === 'claude-sonnet-4-6')).toBe(true);
  });

  it('falls back to text model field when model list is unavailable', async () => {
    await renderSection({ modelListStatus: 'error', modelList: [] });
    expect(screen.getByLabelText(/writing coach model/i).tagName).toBe('INPUT');
  });

  it('hides per-agent model select when provider override is enabled', async () => {
    await renderSection({
      agentOverrides: {
        ...emptyOverrides,
        writingAssistant: {
          enabled: true,
          kind: 'anthropic',
          model: 'x',
          apiKey: 'k',
          apiKeyDirty: false,
          baseUrl: '',
        },
      },
    });
    expect(screen.queryByLabelText(/writing coach model/i)).not.toBeInTheDocument();
  });

  it('beta reader heartbeat and enable fire setAgentField', async () => {
    const { setAgentField } = await renderSection();
    fireEvent.change(document.getElementById('beta-reader-heartbeat')!, { target: { value: '15' } });
    expect(setAgentField).toHaveBeenCalledWith('betaReader', 'heartbeatIntervalMinutes', 15);
    fireEvent.click(screen.getByRole('checkbox', { name: /enable beta reader/i }));
    expect(setAgentField).toHaveBeenCalledWith('betaReader', 'enabled', false);
  });

  it('wiki autonomy select updates settings via setSettings', async () => {
    const { setSettings } = await renderSection({
      settings: {
        apiKey: '',
        theme: 'dark',
        agents: baseAgents,
        agentNames: {},
        wikiAutonomy: 'ask',
      } as AppSettings,
    });
    fireEvent.change(screen.getByTestId('wiki-autonomy-select'), { target: { value: 'auto' } });
    expect(setSettings).toHaveBeenCalled();
  });

  it('clean index shows preserved decisions message', async () => {
    await renderSection();
    fireEvent.click(screen.getByTestId('agent-index-clean-btn'));
    expect(await screen.findByTestId('agent-index-status')).toHaveTextContent(/preserved/i);
  });

  it('rebuild index surfaces error from API', async () => {
    (window.api!.agentIndex!.rebuild as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ error: 'busy' });
    await renderSection();
    fireEvent.click(screen.getByTestId('agent-index-rebuild-btn'));
    expect(await screen.findByTestId('agent-index-status')).toHaveTextContent(/busy/);
  });

  it('brainstorm routing panel lists blank-vault memory and reset', async () => {
    await renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('brainstorm-routing-panel')).toBeInTheDocument();
    });
    expect(screen.getByTestId('brainstorm-routing-memory-character')).toHaveTextContent('People/');
    fireEvent.click(screen.getByTestId('brainstorm-routing-reset-character'));
    await waitFor(() => {
      expect(window.api?.brainstormResetCategoryRouting).toHaveBeenCalledWith('character');
    });
  });

  it('autolinker callout dispatches settings navigate event', async () => {
    await renderSection();
    const handler = vi.fn();
    window.addEventListener('settings:navigate', handler);
    fireEvent.click(screen.getByRole('button', { name: /Vaults & Files/i }));
    expect(handler).toHaveBeenCalled();
    window.removeEventListener('settings:navigate', handler);
  });

  it('production role model change calls setAgentField', async () => {
    const { setAgentField } = await renderSection();
    const select = screen.getByLabelText(/alpha reader model/i) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'mistral' } });
    expect(setAgentField).toHaveBeenCalledWith('alphaReader', 'model', 'mistral');
  });

  it('index stats render last scan timestamp when present', async () => {
    (window.api!.agentIndex!.getStats as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      entityCount: 1,
      lastScanAt: '2020-01-02T03:04:05.000Z',
      factDecisionCount: 2,
      cacheRowCount: 3,
    });
    await renderSection();
    expect(await screen.findByText(/last scan/i)).toBeInTheDocument();
  });

  it('clean index warns when tombstones change', async () => {
    (window.api!.agentIndex!.clean as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      tombstonesIntact: false,
      decisionsPreserved: 0,
    });
    await renderSection();
    fireEvent.click(screen.getByTestId('agent-index-clean-btn'));
    expect(await screen.findByTestId('agent-index-status')).toHaveTextContent(/Warning/i);
  });

  it('fires setAgentField across writing coach and brainstorm numeric controls', async () => {
    const settings = {
      apiKey: '',
      theme: 'dark' as const,
      agents: {
        ...baseAgents,
        writingAssistant: {
          ...baseAgents.writingAssistant,
          cadenceTrigger: 'idle_heartbeat' as const,
        },
      },
      agentNames: {},
    } as AppSettings;
    const { setAgentField } = await renderSection({ settings });
    fireEvent.change(document.getElementById('wa-heartbeat')!, { target: { value: '9' } });
    expect(setAgentField).toHaveBeenCalledWith('writingAssistant', 'heartbeatIntervalMinutes', 9);
    fireEvent.change(document.getElementById('wa-interval')!, { target: { value: '45' } });
    expect(setAgentField).toHaveBeenCalledWith('writingAssistant', 'scanIntervalSeconds', 45);
    fireEvent.change(document.getElementById('brainstorm-heartbeat')!, { target: { value: '11' } });
    expect(setAgentField).toHaveBeenCalledWith('brainstorm', 'heartbeatIntervalMinutes', 11);
    fireEvent.change(document.getElementById('wa-max-tokens-day')!, { target: { value: '2000' } });
    expect(setAgentField).toHaveBeenCalledWith('writingAssistant', 'maxTokensPerDay', 2000);
  });

  it('beta reader and production role toggles fire setAgentField', async () => {
    const settings = {
      apiKey: '',
      theme: 'dark',
      agents: {
        ...baseAgents,
        betaReader: { ...baseAgents.betaReader, autoApply: true },
        alphaReader: { enabled: false, model: '' },
        storylineConsultant: { enabled: false, model: '' },
        lineEditor: { enabled: false, model: '' },
      },
      agentNames: {},
    } as AppSettings;
    const { setAgentField } = await renderSection({ settings });
    fireEvent.change(document.getElementById('beta-reader-confidence')!, { target: { value: '0.55' } });
    expect(setAgentField).toHaveBeenCalledWith('betaReader', 'confidenceThreshold', 0.55);
    fireEvent.change(document.getElementById('beta-reader-max-tokens')!, { target: { value: '5000' } });
    expect(setAgentField).toHaveBeenCalledWith('betaReader', 'maxTokensPerHour', 5000);
    fireEvent.click(screen.getByRole('checkbox', { name: /enable alpha reader/i }));
    expect(setAgentField).toHaveBeenCalledWith('alphaReader', 'enabled', true);
  });

  it('brainstorm auto-apply threshold updates when auto-apply is on', async () => {
    const settings = {
      apiKey: '',
      theme: 'dark' as const,
      agents: {
        ...baseAgents,
        brainstorm: { ...baseAgents.brainstorm, autoApply: true },
      },
      agentNames: {},
    } as AppSettings;
    const { setAgentField } = await renderSection({ settings });
    fireEvent.change(document.getElementById('brainstorm-confidence')!, { target: { value: '0.6' } });
    expect(setAgentField).toHaveBeenCalledWith('brainstorm', 'confidenceThreshold', 0.6);
  });

  it('beta reader auto-apply toggle fires setAgentField', async () => {
    const { setAgentField } = await renderSection();
    fireEvent.click(screen.getByLabelText(/auto-apply beta reader suggestions/i));
    expect(setAgentField).toHaveBeenCalledWith('betaReader', 'autoApply', true);
  });

  it('beta reader day and suggestion caps forward setAgentField', async () => {
    const { setAgentField } = await renderSection();
    fireEvent.change(document.getElementById('beta-reader-max-tokens-day')!, { target: { value: '9000' } });
    expect(setAgentField).toHaveBeenCalledWith('betaReader', 'maxTokensPerDay', 9000);
    fireEvent.change(document.getElementById('beta-reader-max-suggestions')!, { target: { value: '12' } });
    expect(setAgentField).toHaveBeenCalledWith('betaReader', 'maxSuggestionsPerHour', 12);
  });

  it('auto-scan toggle forwards setSettings', async () => {
    const settings = { apiKey: '', theme: 'dark', agents: baseAgents, agentNames: {}, agentIndexAutoScan: true } as AppSettings;
    const setSettings = vi.fn((fn: (p: AppSettings) => AppSettings) => {
      if (typeof fn === 'function') fn(settings);
    });
    await renderSection({ settings, setSettings });
    fireEvent.click(screen.getByLabelText(/background auto-scan on save/i));
    expect(setSettings).toHaveBeenCalled();
  });

  it('agent rename input calls setAgentDisplayName', async () => {
    const setAgentDisplayName = vi.fn();
    render(
      <AgentsSection
        settings={{
          apiKey: '',
          theme: 'dark',
          agents: baseAgents,
          agentNames: { writingAssistant: 'Coach' },
        } as AppSettings}
        providerKind="ollama"
        providerModel="llama3"
        modelList={['llama3']}
        modelListStatus="ok"
        agentOverrides={emptyOverrides}
        agentTestStatus={{ writingAssistant: 'idle', brainstorm: 'idle', archive: 'idle', betaReader: 'idle' }}
        agentTestMsg={{ writingAssistant: '', brainstorm: '', archive: '', betaReader: '' }}
        setAgentField={vi.fn()}
        setCategoryAutoApply={noopCategoryAutoApply}
        setCategoryAutoApplyThreshold={noopCategoryThreshold}
        setAgentOverride={vi.fn()}
        onAgentTest={vi.fn()}
        micDevices={[]}
        refreshMicDevices={vi.fn()}
        setAgentDisplayName={setAgentDisplayName}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('agent-index-controls')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/rename writing coach/i), { target: { value: 'New Coach' } });
    expect(setAgentDisplayName).toHaveBeenCalledWith('writingAssistant', 'New Coach');
  });

  it('refresh microphone list button calls refreshMicDevices', async () => {
    const settings = {
      apiKey: '',
      theme: 'dark' as const,
      agents: {
        ...baseAgents,
        brainstorm: { ...baseAgents.brainstorm, voiceEnabled: true },
      },
      agentNames: {},
    } as AppSettings;
    const refreshMicDevices = vi.fn();
    render(
      <AgentsSection
        settings={settings}
        providerKind="ollama"
        providerModel="llama3"
        modelList={['llama3']}
        modelListStatus="ok"
        agentOverrides={emptyOverrides}
        agentTestStatus={{ writingAssistant: 'idle', brainstorm: 'idle', archive: 'idle', betaReader: 'idle' }}
        agentTestMsg={{ writingAssistant: '', brainstorm: '', archive: '', betaReader: '' }}
        setAgentField={vi.fn()}
        setCategoryAutoApply={noopCategoryAutoApply}
        setCategoryAutoApplyThreshold={noopCategoryThreshold}
        setAgentOverride={vi.fn()}
        onAgentTest={vi.fn()}
        micDevices={[]}
        refreshMicDevices={refreshMicDevices}
        setAgentDisplayName={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('agent-index-controls')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText(/refresh microphone device list/i));
    expect(refreshMicDevices).toHaveBeenCalled();
  });
});