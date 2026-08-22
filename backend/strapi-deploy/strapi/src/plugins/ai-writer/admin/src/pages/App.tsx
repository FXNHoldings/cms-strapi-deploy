import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Field,
  Flex,
  Main,
  SingleSelect,
  SingleSelectOption,
  TextInput,
  Textarea,
  Typography,
  Alert,
  Grid,
} from '@strapi/design-system';
import { useFetchClient, useNotification } from '@strapi/strapi/admin';

type SiteOption = {
  slug: string;
  name: string;
  domain: string;
  niche: string | null;
  country: string | null;
  hasBrief: boolean;
  target: string;
};

type WriterOptions = {
  provider: 'anthropic';
  configured: boolean;
  defaultModel: string;
  maxTokens: number;
  sites: SiteOption[];
};

/* Opened from a site's dashboard as ?site=<slug>, so the page arrives already
   pointed at the right site rather than defaulting to one. */
const siteFromUrl = () => new URLSearchParams(window.location.search).get('site') ?? '';

export const App = () => {
  const { get, post } = useFetchClient();
  const { toggleNotification } = useNotification();
  const [topic, setTopic] = useState('');
  const [tone, setTone] = useState('friendly');
  const [length, setLength] = useState<'short' | 'medium' | 'long'>('medium');
  const [destination, setDestination] = useState('');
  const [category, setCategory] = useState('');
  const [keywords, setKeywords] = useState('');
  const [customInstructions, setCustomInstructions] = useState('');
  const [model, setModel] = useState('');
  const [site, setSite] = useState(siteFromUrl);
  const [options, setOptions] = useState<WriterOptions | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await get('/ai-writer/options');
        setOptions(data);
        setModel(data.defaultModel || '');
        // Only when the URL did not already say which site.
        setSite((current) => current || (data.sites?.length === 1 ? data.sites[0].slug : ''));
      } catch {
        setOptions(null);
      }
    })();
  }, [get]);

  const providerConfigured = options?.configured ?? true;
  const activeSite = options?.sites?.find((s) => s.slug === site) ?? null;

  /*
   * The optional free-text field was labelled "Destination", which only makes
   * sense for the travel sites this plugin was written for. The niche recorded
   * on the site drives the wording instead, and the field is hidden where it
   * has no meaning rather than asking for a destination on a smart-home site.
   */
  const subject = (() => {
    const niche = (activeSite?.niche ?? '').toLowerCase();
    if (niche.includes('travel') || niche.includes('flight')) {
      return { show: true, label: 'Destination', placeholder: 'e.g. Bangkok, Thailand' };
    }
    if (niche.includes('smart') || niche.includes('home') || niche.includes('tech')) {
      return { show: true, label: 'Device or brand', placeholder: 'e.g. Aqara FP2 presence sensor' };
    }
    return { show: Boolean(activeSite), label: 'Subject', placeholder: 'Optional — narrows the article' };
  })();

  const run = async () => {
    if (!topic.trim() || !site) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const { data } = await post('/ai-writer/generate', {
        site,
        subjectLabel: subject.label,
        topic,
        tone,
        length,
        destination: destination || undefined,
        category: category || undefined,
        keywords: keywords ? keywords.split(',').map((k) => k.trim()).filter(Boolean) : undefined,
        customInstructions: customInstructions.trim() || undefined,
        model: model.trim() || undefined,
        createDraft: true,
      });
      setResult(data);
      toggleNotification({ type: 'success', message: 'Draft article created.' });
    } catch (e: any) {
      setError(e?.response?.data?.error?.message || e.message || 'Generation failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Main>
      <Box padding={8}>
        <Typography variant="alpha">AI Writer</Typography>
        <Box paddingTop={2} paddingBottom={6}>
          <Typography variant="omega" textColor="neutral600">
            {activeSite
              ? `Generate an SEO-ready post for ${activeSite.name} with Claude. It is filed as a draft in ${activeSite.target.split('.').pop()} — review it, attach a cover, set the category and author, then publish.`
              : 'Pick a site to write for. The draft is filed in that site\u2019s own posts collection.'}
          </Typography>
          {activeSite && !activeSite.hasBrief && (
            <Box paddingTop={2}>
              <Alert variant="default" title="No brief set for this site">
                {`${activeSite.name} has no aiWriterBrief, so Claude falls back to a generic travel brief. Set one on the site in Content Manager to get copy written for this audience.`}
              </Alert>
            </Box>
          )}
        </Box>

        <Grid.Root gap={4}>
          <Grid.Item col={12} s={12} direction="column" alignItems="stretch">
            <Field.Root name="site" required>
              <Field.Label>Site</Field.Label>
              <SingleSelect
                value={site}
                onChange={(v: any) => setSite(String(v))}
                placeholder="Which site is this post for?"
              >
                {(options?.sites ?? []).map((s) => (
                  <SingleSelectOption key={s.slug} value={s.slug}>
                    {`${s.name} — ${s.domain}`}
                  </SingleSelectOption>
                ))}
              </SingleSelect>
              <Field.Hint>
                {activeSite
                  ? `Drafts are created in ${activeSite.target}`
                  : 'Required — it decides which collection the draft is filed in'}
              </Field.Hint>
            </Field.Root>
          </Grid.Item>

          <Grid.Item col={12} s={12} direction="column" alignItems="stretch">
            <Field.Root name="model">
              <Field.Label>Model</Field.Label>
              <TextInput
                value={model}
                onChange={(e: any) => setModel(e.target.value)}
                placeholder="claude-opus-5"
              />
              <Field.Hint>Defaults to the server's AI_WRITER_ANTHROPIC_MODEL.</Field.Hint>
            </Field.Root>
          </Grid.Item>

          <Grid.Item col={12} s={12} direction="column" alignItems="stretch">
            <Field.Root name="topic" required>
              <Field.Label>Topic</Field.Label>
              <Textarea
                value={topic}
                onChange={(e: any) => setTopic(e.target.value)}
                rows={3}
                placeholder="e.g. Best cheap flights from London to Bangkok in 2026"
              />
            </Field.Root>
          </Grid.Item>

          <Grid.Item col={6} s={12} direction="column" alignItems="stretch">
            <Field.Root name="destination">
              <Field.Label>{`${subject.label} (optional)`}</Field.Label>
              <TextInput value={destination} onChange={(e: any) => setDestination(e.target.value)} placeholder={subject.placeholder} />
            </Field.Root>
          </Grid.Item>

          <Grid.Item col={6} s={12} direction="column" alignItems="stretch">
            <Field.Root name="category">
              <Field.Label>Category (optional)</Field.Label>
              <TextInput value={category} onChange={(e: any) => setCategory(e.target.value)} placeholder="e.g. Flight Deals" />
            </Field.Root>
          </Grid.Item>

          <Grid.Item col={4} s={12} direction="column" alignItems="stretch">
            <Field.Root name="tone">
              <Field.Label>Tone</Field.Label>
              <SingleSelect value={tone} onChange={(v: any) => setTone(v)}>
                <SingleSelectOption value="friendly">Friendly</SingleSelectOption>
                <SingleSelectOption value="professional">Professional</SingleSelectOption>
                <SingleSelectOption value="adventurous">Adventurous</SingleSelectOption>
                <SingleSelectOption value="witty">Witty</SingleSelectOption>
                <SingleSelectOption value="luxury">Luxury</SingleSelectOption>
              </SingleSelect>
            </Field.Root>
          </Grid.Item>

          <Grid.Item col={4} s={12} direction="column" alignItems="stretch">
            <Field.Root name="length">
              <Field.Label>Length</Field.Label>
              <SingleSelect value={length} onChange={(v: any) => setLength(v)}>
                <SingleSelectOption value="short">Short (~500 words)</SingleSelectOption>
                <SingleSelectOption value="medium">Medium (~1000 words)</SingleSelectOption>
                <SingleSelectOption value="long">Long (~1800 words)</SingleSelectOption>
              </SingleSelect>
            </Field.Root>
          </Grid.Item>

          <Grid.Item col={4} s={12} direction="column" alignItems="stretch">
            <Field.Root name="keywords">
              <Field.Label>Keywords (comma-separated)</Field.Label>
              <TextInput value={keywords} onChange={(e: any) => setKeywords(e.target.value)} placeholder="cheap flights, bangkok, 2026" />
            </Field.Root>
          </Grid.Item>

          <Grid.Item col={12} s={12} direction="column" alignItems="stretch">
            <Field.Root name="customInstructions">
              <Field.Label>Additional instructions (optional)</Field.Label>
              <Textarea
                value={customInstructions}
                onChange={(e: any) => setCustomInstructions(e.target.value)}
                rows={12}
                placeholder="e.g. Mention budget airlines, include a packing list section, avoid luxury positioning"
              />
            </Field.Root>
          </Grid.Item>
        </Grid.Root>

        {!providerConfigured && (
          <Box paddingTop={4}>
            <Alert variant="warning" title="API key missing">
              Set ANTHROPIC_API_KEY in Strapi .env and restart Strapi.
            </Alert>
          </Box>
        )}

        <Box paddingTop={6}>
          <Flex gap={3}>
            <Button loading={loading} disabled={!topic.trim() || !site || !providerConfigured} onClick={run}>
              Generate article
            </Button>
            <Button
              variant="tertiary"
              onClick={() => {
                setTopic('');
                setCustomInstructions('');
                setResult(null);
                setError(null);
              }}
            >
              Reset
            </Button>
          </Flex>
        </Box>

        {error && (
          <Box paddingTop={6}>
            <Alert variant="danger" title="Generation failed">{error}</Alert>
          </Box>
        )}

        {result?.draft && (
          <Box paddingTop={8}>
            <Typography variant="beta">Preview: {result.draft.title}</Typography>
            {result?.meta?.provider && (
              <Box paddingTop={1}>
                <Typography textColor="neutral600">
                  {result.meta.provider} / {result.meta.model}
                </Typography>
              </Box>
            )}
            <Box paddingTop={2}>
              <Typography textColor="neutral600">{result.draft.excerpt}</Typography>
            </Box>
            <Box paddingTop={4} background="neutral100" padding={4} hasRadius>
              <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{result.draft.content}</pre>
            </Box>
            {result.created?.id && (
              <Box paddingTop={4}>
                <Alert variant="success" title="Draft saved">
                  Article ID {result.created.id} — open it in the Content Manager to finish editing.
                </Alert>
              </Box>
            )}
          </Box>
        )}
      </Box>
    </Main>
  );
};

export default App;
