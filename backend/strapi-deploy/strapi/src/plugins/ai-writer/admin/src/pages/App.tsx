import { useState } from 'react';
import {
  Box,
  Button,
  Field,
  Flex,
  Main,
  SingleSelect,
  SingleSelectOption,
  Textarea,
  Typography,
  Alert,
  Grid,
} from '@strapi/design-system';
import { useFetchClient, useNotification } from '@strapi/strapi/admin';

export const App = () => {
  const { post } = useFetchClient();
  const { toggleNotification } = useNotification();
  const [topic, setTopic] = useState('');
  const [tone, setTone] = useState('friendly');
  const [length, setLength] = useState<'short' | 'medium' | 'long'>('medium');
  const [destination, setDestination] = useState('');
  const [category, setCategory] = useState('');
  const [keywords, setKeywords] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

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
            Generate SEO-ready travel articles with Claude Sonnet 4.5. A draft Article will be
            created — review, attach media, pick destinations, then publish.
          </Typography>
        </Box>

        <Grid.Root gap={4}>
          <Grid.Item col={12} s={12}>
            <Field.Root name="topic" required>
              <Field.Label>Topic</Field.Label>
              <Textarea
                value={topic}
                onChange={(e: any) => setTopic(e.target.value)}
                placeholder="e.g. Best cheap flights from London to Bangkok in 2026"
              />
            </Field.Root>
          </Grid.Item>

          <Grid.Item col={6} s={12}>
            <Field.Root name="destination">
              <Field.Label>Destination (optional)</Field.Label>
              <Textarea value={destination} onChange={(e: any) => setDestination(e.target.value)} />
            </Field.Root>
          </Grid.Item>

          <Grid.Item col={6} s={12}>
            <Field.Root name="category">
              <Field.Label>Category (optional)</Field.Label>
              <Textarea value={category} onChange={(e: any) => setCategory(e.target.value)} />
            </Field.Root>
          </Grid.Item>

          <Grid.Item col={4} s={12}>
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

          <Grid.Item col={4} s={12}>
            <Field.Root name="length">
              <Field.Label>Length</Field.Label>
              <SingleSelect value={length} onChange={(v: any) => setLength(v)}>
                <SingleSelectOption value="short">Short (~500 words)</SingleSelectOption>
                <SingleSelectOption value="medium">Medium (~1000 words)</SingleSelectOption>
                <SingleSelectOption value="long">Long (~1800 words)</SingleSelectOption>
              </SingleSelect>
            </Field.Root>
          </Grid.Item>

          <Grid.Item col={4} s={12}>
            <Field.Root name="keywords">
              <Field.Label>Keywords (comma-separated)</Field.Label>
              <Textarea value={keywords} onChange={(e: any) => setKeywords(e.target.value)} />
            </Field.Root>
          </Grid.Item>
        </Grid.Root>

        <Box paddingTop={6}>
          <Flex gap={3}>
            <Button loading={loading} disabled={!topic.trim()} onClick={run}>
              Generate article
            </Button>
            <Button variant="tertiary" onClick={() => { setTopic(''); setResult(null); setError(null); }}>
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
