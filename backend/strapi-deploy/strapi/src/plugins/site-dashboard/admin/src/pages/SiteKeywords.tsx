import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert, Badge, Box, Button, Checkbox, Field, Flex, Loader, Main, TextInput, Typography,
} from '@strapi/design-system';
import { useFetchClient } from '@strapi/strapi/admin';

/**
 * Keyword research for one site.
 *
 * The measured/inferred split is carried through to the screen on purpose.
 * Volume, competition and CPC come from DataForSEO and are real; relevance,
 * intent and the suggestion are the model's reading of them. Presenting the
 * two identically would turn a judgement into a statistic.
 *
 * Note the label: this is search volume for the keyword, not traffic the site
 * would receive. Ranking for a term does not hand you its whole volume, and
 * saying "visitors/month" would be a claim the data does not support.
 */

type Keyword = {
  keyword: string;
  volume: number | null;
  competition: number | null;
  cpc?: number | null;
  relevance: number | null;
  intent: string | null;
  suggestion: string | null;
};

const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * (v <= 1 ? 100 : 1))}%`);

export default function SiteKeywords() {
  const { slug } = useParams();
  const { get, post } = useFetchClient();

  const [seed, setSeed] = useState('');
  const [count, setCount] = useState('20');
  const [longtail, setLongtail] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [rows, setRows] = useState<Keyword[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<any>(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const poll = (runId: string) => {
    timer.current = setTimeout(async () => {
      try {
        const { data } = await get(`/site-dashboard/sites/${slug}/keywords/${runId}`);
        if (data.status === 'running') return poll(runId);
        setRunning(false);
        setStatus(null);
        if (data.error) return setError(data.error);
        setRows(Array.isArray(data.keywords) ? data.keywords : []);
      } catch (e: any) {
        setRunning(false);
        setStatus(null);
        setError(e?.response?.data?.error?.message || e.message || 'Could not read the result');
      }
    }, 3000);
  };

  const run = async () => {
    if (!seed.trim() || running) return;
    setRunning(true);
    setError(null);
    setRows([]);
    setStatus('Asking DataForSEO for real volumes, then judging relevance…');
    try {
      const { data } = await post(`/site-dashboard/sites/${slug}/keywords`, {
        seed: seed.trim(), count, longtail,
      });
      poll(data.runId);
    } catch (e: any) {
      setRunning(false);
      setStatus(null);
      setError(e?.response?.data?.error?.message || e.message || 'Could not start the research');
    }
  };

  const copy = (k: string) => {
    navigator.clipboard?.writeText(k);
    setCopied(k);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <Main>
      <Box padding={8}>
        <Box paddingBottom={2}>
          <Button variant="tertiary" size="S" tag={Link} to={`/plugins/site-dashboard/${slug}`}>
            ← Back to site
          </Button>
        </Box>

        <Typography variant="alpha">Keyword research</Typography>
        <Box paddingTop={2} paddingBottom={6}>
          <Typography variant="omega" textColor="neutral600">
            Search volume, competition and CPC are measured — Google Ads data via DataForSEO.
            Relevance, intent and the suggestion are the model reading those numbers for this
            site. Each search is billed, so it only runs when you ask.
          </Typography>
        </Box>

        <Flex gap={4} alignItems="flex-end" wrap="wrap" paddingBottom={6}>
          <Box style={{ minWidth: 320, flex: 1 }}>
            <Field.Root name="seed" required>
              <Field.Label>Seed keyword</Field.Label>
              <TextInput
                value={seed}
                onChange={(e: any) => setSeed(e.target.value)}
                placeholder="e.g. smart doorbell"
                onKeyDown={(e: any) => e.key === 'Enter' && run()}
              />
            </Field.Root>
          </Box>
          <Box style={{ width: 140 }}>
            <Field.Root name="count">
              <Field.Label>How many</Field.Label>
              <TextInput value={count} onChange={(e: any) => setCount(e.target.value)} />
            </Field.Root>
          </Box>
          <Box paddingBottom={2}>
            <Checkbox checked={longtail} onCheckedChange={(v: any) => setLongtail(Boolean(v))}>
              Longtail only
            </Checkbox>
          </Box>
          <Box paddingBottom={1}>
            <Button onClick={run} loading={running} disabled={!seed.trim() || running}>
              Research
            </Button>
          </Box>
        </Flex>

        {status && (
          <Flex gap={3} alignItems="center" paddingBottom={4}>
            <Loader small>Working</Loader>
            <Typography variant="omega" textColor="neutral600">{status}</Typography>
          </Flex>
        )}

        {error && (
          <Box paddingBottom={4}>
            <Alert variant="danger" title="Research failed">{error}</Alert>
          </Box>
        )}

        {rows.map((k) => (
          <Box
            key={k.keyword}
            background="neutral0"
            hasRadius
            shadow="tableShadow"
            padding={5}
            marginBottom={4}
          >
            <Flex justifyContent="space-between" alignItems="flex-start" gap={4} wrap="wrap">
              <Typography variant="delta">{k.keyword}</Typography>
              {k.relevance != null && (
                <Badge backgroundColor={k.relevance >= 70 ? 'success100' : k.relevance >= 40 ? 'warning100' : 'neutral150'}>
                  {`Relevance ${k.relevance}%`}
                </Badge>
              )}
            </Flex>

            <Flex gap={8} paddingTop={4} wrap="wrap">
              <Box>
                <Typography variant="sigma" textColor="neutral600">Search volume · measured</Typography>
                <Box paddingTop={1}>
                  <Typography variant="omega">
                    {k.volume == null ? '—' : `${k.volume.toLocaleString()} searches/mo`}
                  </Typography>
                </Box>
              </Box>
              <Box>
                <Typography variant="sigma" textColor="neutral600">Competition · measured</Typography>
                <Box paddingTop={1}><Typography variant="omega">{pct(k.competition)}</Typography></Box>
              </Box>
              {k.cpc != null && (
                <Box>
                  <Typography variant="sigma" textColor="neutral600">CPC · measured</Typography>
                  <Box paddingTop={1}><Typography variant="omega">{`$${Number(k.cpc).toFixed(2)}`}</Typography></Box>
                </Box>
              )}
            </Flex>

            {(k.intent || k.suggestion) && (
              <Flex gap={8} paddingTop={4} wrap="wrap" alignItems="flex-start">
                {k.intent && (
                  <Box style={{ maxWidth: 340 }}>
                    <Typography variant="sigma" textColor="neutral600">Intent · inferred</Typography>
                    <Box paddingTop={1}><Typography variant="omega" textColor="neutral700">{k.intent}</Typography></Box>
                  </Box>
                )}
                {k.suggestion && (
                  <Box style={{ maxWidth: 460 }}>
                    <Typography variant="sigma" textColor="neutral600">What to publish · inferred</Typography>
                    <Box paddingTop={1}><Typography variant="omega" textColor="neutral700">{k.suggestion}</Typography></Box>
                  </Box>
                )}
              </Flex>
            )}

            <Flex gap={2} paddingTop={5} wrap="wrap">
              {/* Carries the site AND the topic, so AI Writer opens ready to run
                  and files the draft in this site's own posts collection. */}
              <Button
                variant="secondary"
                size="S"
                tag="a"
                href={`/admin/plugins/ai-writer?site=${slug}&topic=${encodeURIComponent(k.suggestion || k.keyword)}&keyword=${encodeURIComponent(k.keyword)}`}
              >
                Create article
              </Button>
              <Button variant="tertiary" size="S" tag="a" href={`/admin/plugins/commerce-product-finder?site=${slug}&q=${encodeURIComponent(k.keyword)}`}>
                Find products
              </Button>
              <Button variant="tertiary" size="S" onClick={() => copy(k.keyword)}>
                {copied === k.keyword ? 'Copied' : 'Copy keyword'}
              </Button>
            </Flex>
          </Box>
        ))}

        {!running && !error && rows.length === 0 && (
          <Typography variant="omega" textColor="neutral600">
            Enter a seed keyword to see what people actually search for.
          </Typography>
        )}
      </Box>
    </Main>
  );
}
