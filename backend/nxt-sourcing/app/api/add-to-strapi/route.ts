import { NextResponse } from 'next/server';
import { addProductToStrapi } from '@/lib/strapi-commerce';
import { normalizeStorefront } from '@/lib/storefronts';

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const item = body.item;
  const dryRun = body.dryRun !== false;
  const importSpecs = body.importSpecs !== false;
  const importDescription = body.importDescription === true;
  const overwriteProductDetails = body.overwriteProductDetails === true;
  const categoryName = typeof body.categoryName === 'string' ? body.categoryName : undefined;
  const targetProductDocumentId =
    typeof body.targetProductDocumentId === 'string' ? body.targetProductDocumentId : undefined;
  const storefront = normalizeStorefront(body.storefront);

  if (!item?.productName || !item?.merchantSlug || !item?.productUrl) {
    return NextResponse.json({ error: 'Missing productName, merchantSlug, or productUrl.' }, { status: 400 });
  }

  if (!dryRun && item.confidence === 'demo') {
    return NextResponse.json(
      { ok: false, dryRun, message: 'Demo provider results cannot be written to Strapi. Use dry run or connect a real provider.' },
      { status: 400 },
    );
  }

  try {
    const result = await addProductToStrapi(item, {
      dryRun,
      importSpecs,
      importDescription,
      overwriteProductDetails,
      categoryName,
      targetProductDocumentId,
      storefront,
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (error) {
    return NextResponse.json(
      { ok: false, dryRun, message: error instanceof Error ? error.message : 'Unknown Strapi write error.' },
      { status: 500 },
    );
  }
}
