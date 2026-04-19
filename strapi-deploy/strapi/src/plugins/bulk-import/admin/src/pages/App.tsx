import { useState, useRef } from 'react';
import {
  Alert, Box, Button, Flex, Main, Tabs, Typography,
} from '@strapi/design-system';
import { useFetchClient, useNotification } from '@strapi/strapi/admin';

export const App = () => {
  const { post } = useFetchClient();
  const { toggleNotification } = useNotification();
  const mdRef = useRef<HTMLInputElement>(null);
  const csvRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const upload = async (path: 'markdown' | 'csv', fieldName: 'files' | 'file', input: HTMLInputElement | null) => {
    if (!input?.files?.length) return;
    setLoading(true); setError(null); setReport(null);
    try {
      const form = new FormData();
      Array.from(input.files).forEach((f) => form.append(fieldName, f));
      const { data } = await post(`/bulk-import/${path}`, form);
      setReport(data);
      toggleNotification({ type: 'success', message: `Imported ${data.created} article(s)` });
    } catch (e: any) {
      setError(e?.response?.data?.error?.message || e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Main>
      <Box padding={8}>
        <Typography variant="alpha">Bulk Import</Typography>
        <Box paddingTop={2} paddingBottom={6}>
          <Typography variant="omega" textColor="neutral600">
            Drop Markdown files (with YAML frontmatter) or a CSV to create articles in bulk.
            Unknown categories, tags, destinations and authors are auto-created.
          </Typography>
        </Box>

        <Tabs.Root defaultValue="md">
          <Tabs.List>
            <Tabs.Trigger value="md">Markdown (.md)</Tabs.Trigger>
            <Tabs.Trigger value="csv">CSV</Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value="md">
            <Box padding={6} background="neutral100" hasRadius marginTop={4}>
              <Typography variant="delta">Markdown files</Typography>
              <Box paddingTop={2}>
                <Typography textColor="neutral600">
                  Frontmatter keys supported: title, slug, excerpt, category, tags (array),
                  destinations (array), author, seoTitle, seoDescription, keywords (array), readingTimeMinutes.
                </Typography>
              </Box>
              <Box paddingTop={4}>
                <input ref={mdRef} type="file" accept=".md,text/markdown" multiple />
              </Box>
              <Box paddingTop={4}>
                <Button loading={loading} onClick={() => upload('markdown', 'files', mdRef.current)}>
                  Upload Markdown
                </Button>
              </Box>
            </Box>
          </Tabs.Content>

          <Tabs.Content value="csv">
            <Box padding={6} background="neutral100" hasRadius marginTop={4}>
              <Typography variant="delta">CSV file</Typography>
              <Box paddingTop={2}>
                <Typography textColor="neutral600">
                  Headers: title, slug, excerpt, content, category, tags, destinations, author,
                  seoTitle, seoDescription, keywords, readingTimeMinutes. Use "|" to separate
                  multiple tags/destinations/keywords.
                </Typography>
              </Box>
              <Box paddingTop={4}>
                <input ref={csvRef} type="file" accept=".csv,text/csv" />
              </Box>
              <Box paddingTop={4}>
                <Button loading={loading} onClick={() => upload('csv', 'file', csvRef.current)}>
                  Upload CSV
                </Button>
              </Box>
            </Box>
          </Tabs.Content>
        </Tabs.Root>

        {error && (
          <Box paddingTop={6}>
            <Alert variant="danger" title="Import failed">{error}</Alert>
          </Box>
        )}

        {report && (
          <Box paddingTop={6}>
            <Alert variant={report.errors.length ? 'warning' : 'success'} title="Import report">
              <Flex direction="column" alignItems="flex-start" gap={1}>
                <Typography>Created: {report.created}</Typography>
                <Typography>Skipped: {report.skipped}</Typography>
                <Typography>Errors: {report.errors.length}</Typography>
              </Flex>
            </Alert>
            {report.errors.length > 0 && (
              <Box paddingTop={3} background="neutral100" padding={4} hasRadius>
                <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                  {JSON.stringify(report.errors, null, 2)}
                </pre>
              </Box>
            )}
          </Box>
        )}
      </Box>
    </Main>
  );
};

export default App;
