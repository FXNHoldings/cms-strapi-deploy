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

type WriterOptions = {
  provider: 'anthropic';
  configured: boolean;
  defaultModel: string;
  maxTokens: number;
};

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
      } catch {
        setOptions(null);
      }
    })();
  }, [get]);

  const providerConfigured = options?.configured ?? true;

  const run = async () => {
    if (!topic.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const { data } = await post('/ai-writer/generate', {
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
            Generate SEO-ready travel articles with Claude. A draft Article will be created —
            review, attach media, pick destinations, then publish.
          </Typography>
        </Box>

        <Grid.Root gap={4}>
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
              <Field.Label>Destination (optional)</Field.Label>
              <TextInput value={destination} onChange={(e: any) => setDestination(e.target.value)} placeholder="e.g. Bangkok, Thailand" />
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
            <Button loading={loading} disabled={!topic.trim() || !providerConfigured} onClick={run}>
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
