import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, Badge, Box, Button, Field, Flex, Grid, Loader, Main,
  SingleSelect, SingleSelectOption, Textarea, TextInput, Typography,
} from '@strapi/design-system';
import { useFetchClient } from '@strapi/strapi/admin';

/**
 * Content Jobs — run the sourcing and enrichment scripts from the admin.
 *
 * The scripts live on the host, not in this container, so everything here goes
 * through the plugin's server routes to the job runner. Nothing is executed in
 * the browser and the runner token never reaches it.
 *
 * Two deliberate safety properties, because these jobs spend money and write to
 * the live catalogue:
 *
 *   - Dry run is the default action. The scripts are read-only until their
 *     write flag is passed, so rehearsing costs nothing and changes nothing.
 *   - Committing a paid job needs a second, explicit click on a separate
 *     button that states the estimated cost. There is no way to spend by
 *     pressing the obvious button.
 */

type Param = {
  name: string; label: string; type: 'text' | 'number' | 'boolean' | 'select' | 'textarea';
  placeholder?: string; hint?: string; default?: string; required?: boolean; rows?: number;
  options?: { value: string; label: string }[];
};
type Job = {
  id: string; title: string; summary: string; script: string;
  paid: boolean; costPerItem?: number; writeFlag: string | null; params: Param[];
};
type Run = {
  id: string; jobId: string; title: string; script: string; args: string[];
  paid: boolean; write: boolean; willSpend: boolean;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  exitCode: number | null; startedAt: number; endedAt: number | null;
};

const STATUS_TONE: Record<string, 'success' | 'danger' | 'warning' | 'secondary'> = {
  succeeded: 'success', failed: 'danger', cancelled: 'warning',
  interrupted: 'warning', running: 'secondary',
};

const fmtWhen = (ms: number) => new Date(ms).toLocaleString();
const fmtDuration = (a: number, b: number | null) => {
  const s = Math.round(((b ?? Date.now()) - a) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

const App = () => {
  const { get, post } = useFetchClient();

  const [jobs, setJobs] = useState<Job[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState<Job | null>(null);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [activeRun, setActiveRun] = useState<Run | null>(null);
  const [log, setLog] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const offsetRef = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);

  const loadRuns = useCallback(async () => {
    try {
      const { data } = await get('/content-jobs/runs');
      setRuns(data.runs ?? []);
    } catch { /* the banner from the initial load is enough */ }
  }, [get]);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await get('/content-jobs/jobs');
        setJobs(data.jobs ?? []);
        if (data.error) setError(data.error);
      } catch (e: any) {
        setError(e?.response?.data?.error ?? 'Could not load the job catalogue.');
      }
      loadRuns();
    })();
  }, [get, loadRuns]);

  const pick = (job: Job) => {
    setSelected(job);
    setError('');
    const seed: Record<string, string | boolean> = {};
    for (const p of job.params) if (p.default !== undefined) seed[p.name] = p.default;
    setValues(seed);
  };

  /* Poll the log while a run is active. Polling rather than a socket: runs are
     minutes long, a second of latency is irrelevant, and there is no connection
     to lose when the admin tab sleeps. */
  useEffect(() => {
    if (!activeRun || activeRun.status !== 'running') return undefined;
    const id = window.setInterval(async () => {
      try {
        const { data } = await get(`/content-jobs/runs/${activeRun.id}/log?offset=${offsetRef.current}`);
        if (data.text) {
          offsetRef.current = data.offset;
          setLog((prev) => prev + data.text);
          requestAnimationFrame(() => {
            if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
          });
        }
        if (data.status && data.status !== 'running') {
          setActiveRun((r) => (r ? { ...r, status: data.status, exitCode: data.exitCode } : r));
          loadRuns();
        }
      } catch { /* transient; the next tick retries */ }
    }, 1500);
    return () => window.clearInterval(id);
  }, [activeRun, get, loadRuns]);

  const run = async (write: boolean) => {
    if (!selected) return;
    setBusy(true); setError(''); setLog(''); offsetRef.current = 0;
    try {
      const { data } = await post('/content-jobs/runs', { jobId: selected.id, values, write });
      if (data.error) { setError(data.error); return; }
      setActiveRun(data.run);
      loadRuns();
    } catch (e: any) {
      setError(e?.response?.data?.error ?? 'Could not start the job.');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!activeRun) return;
    try {
      await post(`/content-jobs/runs/${activeRun.id}/cancel`, {});
      loadRuns();
    } catch { /* the status poll will catch up */ }
  };

  const estimate = () => {
    if (!selected?.paid) return null;
    const n = Number(values.limit);
    if (!Number.isFinite(n) || n <= 0) return 'Cost depends on how many products match — set a limit to bound it.';
    return `About $${(n * (selected.costPerItem ?? 0.001)).toFixed(3)} for ${n} products.`;
  };

  return (
    <Main>
      <Box padding={8}>
        <Typography variant="alpha">Content Jobs</Typography>
        <Box paddingTop={2} paddingBottom={6}>
          <Typography variant="omega" textColor="neutral600">
            Run the sourcing, pricing and enrichment scripts. Everything writes straight into this
            CMS. Jobs rehearse by default — nothing is changed or charged until you commit.
          </Typography>
        </Box>

        {error ? (
          <Box paddingBottom={4}><Alert variant="danger" title="Problem" onClose={() => setError('')}>{error}</Alert></Box>
        ) : null}

        <Grid.Root gap={6}>
          {/* -------------------------------------------------- job catalogue */}
          <Grid.Item col={4} s={12} direction="column" alignItems="stretch">
            <Typography variant="delta">Jobs</Typography>
            <Box paddingTop={3}>
              <Flex direction="column" alignItems="stretch" gap={2}>
                {jobs.map((job) => (
                  <Box
                    key={job.id}
                    padding={3}
                    hasRadius
                    background={selected?.id === job.id ? 'primary100' : 'neutral0'}
                    borderColor={selected?.id === job.id ? 'primary600' : 'neutral200'}
                    style={{ cursor: 'pointer' }}
                    onClick={() => pick(job)}
                  >
                    <Flex justifyContent="space-between" alignItems="center" gap={2}>
                      <Typography fontWeight="bold">{job.title}</Typography>
                      {job.paid ? <Badge textColor="warning600" backgroundColor="warning100">costs</Badge> : null}
                    </Flex>
                    <Box paddingTop={1}>
                      <Typography variant="pi" textColor="neutral600">{job.summary}</Typography>
                    </Box>
                  </Box>
                ))}
                {jobs.length === 0 && !error ? <Loader small>Loading…</Loader> : null}
              </Flex>
            </Box>
          </Grid.Item>

          {/* ------------------------------------------------------ run panel */}
          <Grid.Item col={8} s={12} direction="column" alignItems="stretch">
            {!selected ? (
              <Box padding={6} hasRadius background="neutral100">
                <Typography textColor="neutral600">Pick a job on the left to configure it.</Typography>
              </Box>
            ) : (
              <>
                <Typography variant="delta">{selected.title}</Typography>
                <Box paddingTop={1} paddingBottom={4}>
                  <Typography variant="pi" textColor="neutral600">
                    scripts/{selected.script}
                  </Typography>
                </Box>

                <Grid.Root gap={4}>
                  {selected.params.map((p) => (
                    <Grid.Item
                      key={p.name}
                      col={p.type === 'textarea' ? 12 : 6}
                      s={12}
                      direction="column"
                      alignItems="stretch"
                    >
                      <Field.Root name={p.name} required={p.required}>
                        <Field.Label>{p.label}</Field.Label>
                        {p.type === 'boolean' ? (
                          <Button
                            variant={values[p.name] ? 'success' : 'tertiary'}
                            onClick={() => setValues((v) => ({ ...v, [p.name]: !v[p.name] }))}
                          >
                            {values[p.name] ? 'On' : 'Off'}
                          </Button>
                        ) : p.type === 'select' ? (
                          <SingleSelect
                            value={String(values[p.name] ?? p.default ?? '')}
                            onChange={(v: any) => setValues((s) => ({ ...s, [p.name]: v }))}
                          >
                            {(p.options ?? []).map((o) => (
                              <SingleSelectOption key={o.value} value={o.value}>{o.label}</SingleSelectOption>
                            ))}
                          </SingleSelect>
                        ) : p.type === 'textarea' ? (
                          <Textarea
                            rows={p.rows ?? 6}
                            placeholder={p.placeholder}
                            value={String(values[p.name] ?? '')}
                            onChange={(e: any) => setValues((s) => ({ ...s, [p.name]: e.target.value }))}
                          />
                        ) : (
                          <TextInput
                            type={p.type === 'number' ? 'number' : 'text'}
                            placeholder={p.placeholder}
                            value={String(values[p.name] ?? '')}
                            onChange={(e: any) => setValues((s) => ({ ...s, [p.name]: e.target.value }))}
                          />
                        )}
                        {p.hint ? <Field.Hint>{p.hint}</Field.Hint> : null}
                      </Field.Root>
                    </Grid.Item>
                  ))}
                </Grid.Root>

                {selected.paid ? (
                  <Box paddingTop={4}>
                    <Alert variant="warning" title="This job spends DataForSEO credit">
                      {estimate()} A dry run costs nothing and shows exactly what would change.
                    </Alert>
                  </Box>
                ) : null}

                <Box paddingTop={4}>
                  <Flex gap={2}>
                    <Button onClick={() => run(false)} loading={busy} variant="secondary">
                      Dry run
                    </Button>
                    <Button
                      onClick={() => run(true)}
                      loading={busy}
                      variant={selected.paid ? 'danger' : 'default'}
                      disabled={!selected.writeFlag && !selected.paid ? false : false}
                    >
                      {selected.paid ? 'Run for real (spends credit)' : 'Run for real'}
                    </Button>
                    {activeRun?.status === 'running' ? (
                      <Button onClick={cancel} variant="tertiary">Cancel</Button>
                    ) : null}
                  </Flex>
                </Box>

                {activeRun ? (
                  <Box paddingTop={5}>
                    <Flex justifyContent="space-between" alignItems="center">
                      <Typography variant="delta">Output</Typography>
                      <Badge textColor="neutral800" backgroundColor="neutral150">
                        {activeRun.status}{activeRun.exitCode !== null ? ` · exit ${activeRun.exitCode}` : ''}
                      </Badge>
                    </Flex>
                    <Box
                      ref={logRef as any}
                      marginTop={2}
                      padding={4}
                      hasRadius
                      background="neutral900"
                      style={{ maxHeight: 420, overflowY: 'auto' }}
                    >
                      <pre style={{ margin: 0, color: '#d7dce3', fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                        {log || 'waiting for output…'}
                      </pre>
                    </Box>
                  </Box>
                ) : null}
              </>
            )}
          </Grid.Item>
        </Grid.Root>

        {/* ------------------------------------------------------- run history */}
        <Box paddingTop={8}>
          <Typography variant="delta">Recent runs</Typography>
          <Box paddingTop={3}>
            <Flex direction="column" alignItems="stretch" gap={1}>
              {runs.slice(0, 15).map((r) => (
                <Box key={r.id} padding={3} hasRadius background="neutral0" borderColor="neutral200">
                  <Flex justifyContent="space-between" alignItems="center" gap={3}>
                    <Flex gap={3} alignItems="center">
                      <Badge textColor={`${STATUS_TONE[r.status] ?? 'secondary'}600` as any}>{r.status}</Badge>
                      <Typography fontWeight="bold">{r.title}</Typography>
                      <Typography variant="pi" textColor="neutral600">
                        {r.write ? 'committed' : 'dry run'}{r.willSpend ? ' · spent credit' : ''}
                      </Typography>
                    </Flex>
                    <Typography variant="pi" textColor="neutral600">
                      {fmtWhen(r.startedAt)} · {fmtDuration(r.startedAt, r.endedAt)}
                    </Typography>
                  </Flex>
                </Box>
              ))}
              {runs.length === 0 ? (
                <Typography variant="pi" textColor="neutral600">No runs yet.</Typography>
              ) : null}
            </Flex>
          </Box>
        </Box>
      </Box>
    </Main>
  );
};

export { App };
export default App;
