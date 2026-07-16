import { FAL_BACKGROUND_REMOVAL_ENABLED, FAL_BACKGROUND_REMOVAL_MODEL, FAL_KEY, STRAPI_API_TOKEN, STRAPI_URL } from './config';

type FalImage = {
  url?: string;
  content_type?: string;
  file_name?: string;
};

type StrapiUploadFile = {
  id?: number;
  url?: string;
  mime?: string;
  name?: string;
};

export type ProductImagePreparation = {
  sourceImageUrl?: string;
  imageUrl?: string;
  mediaId?: number;
  backgroundRemoved: boolean;
  backgroundProvider?: string;
  backgroundStorage?: 'strapi-media' | 'fal-url';
  error?: string;
};

export async function prepareProductImage(sourceImageUrl: string | undefined, filenameBase: string): Promise<ProductImagePreparation> {
  if (!sourceImageUrl || !isHttpUrl(sourceImageUrl)) {
    return { backgroundRemoved: false };
  }

  // Optional enhancement: remove the background via fal.ai, then upload the
  // result. If it's disabled, unconfigured, or fails, we fall through and still
  // import the ORIGINAL image so the product always gets a primaryImage.
  if (FAL_BACKGROUND_REMOVAL_ENABLED && FAL_KEY) {
    try {
      const falImage = await removeBackgroundWithFal(sourceImageUrl);
      if (falImage.url && isHttpUrl(falImage.url)) {
        const upload = await uploadRemoteImageToStrapi(falImage.url, `${filenameBase}-no-bg`, falImage.content_type);
        if (upload?.id) {
          return {
            sourceImageUrl,
            imageUrl: upload.url ? absoluteStrapiUrl(upload.url) : falImage.url,
            mediaId: upload.id,
            backgroundRemoved: true,
            backgroundProvider: FAL_BACKGROUND_REMOVAL_MODEL,
            backgroundStorage: 'strapi-media',
          };
        }
      }
    } catch (error) {
      console.error('Product image background removal failed; importing original image instead.', error);
    }
  }

  // Default path: upload the original product image into Strapi media so it
  // can be set as the product's primaryImage.
  try {
    const upload = await uploadRemoteImageToStrapi(sourceImageUrl, filenameBase);
    return {
      sourceImageUrl,
      imageUrl: upload?.url ? absoluteStrapiUrl(upload.url) : sourceImageUrl,
      mediaId: upload?.id,
      backgroundRemoved: false,
      backgroundStorage: upload?.id ? 'strapi-media' : undefined,
    };
  } catch (error) {
    console.error('Product image import failed', error);
    return {
      sourceImageUrl,
      imageUrl: sourceImageUrl,
      backgroundRemoved: false,
      error: error instanceof Error ? error.message : 'Unknown image import error',
    };
  }
}

async function removeBackgroundWithFal(imageUrl: string): Promise<FalImage> {
  const response = await fetch(`https://fal.run/${FAL_BACKGROUND_REMOVAL_MODEL}`, {
    method: 'POST',
    headers: {
      Authorization: `Key ${FAL_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      image_url: imageUrl,
      sync_mode: false,
      crop_to_bbox: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`fal.ai background removal failed: HTTP ${response.status} ${await response.text().catch(() => '')}`);
  }

  const data = await response.json();
  const image = data?.image;
  if (image?.url) return image;

  throw new Error('fal.ai background removal returned no image URL');
}

export async function uploadRemoteImageToStrapi(
  imageUrl: string,
  filenameBase: string,
  preferredMime?: string,
): Promise<StrapiUploadFile | null> {
  if (!STRAPI_API_TOKEN) return null;

  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Could not download background-removed image: HTTP ${response.status}`);
  }

  const mime = preferredMime || response.headers.get('content-type') || 'image/png';
  if (!mime.startsWith('image/')) {
    throw new Error(`Background-removed asset is not an image: ${mime}`);
  }

  const extension = fileExtensionForMime(mime);
  const blob = new Blob([await response.arrayBuffer()], { type: mime });
  const form = new FormData();
  form.append('files', blob, `${safeFilename(filenameBase)}.${extension}`);

  const uploadResponse = await fetch(`${STRAPI_URL}/api/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STRAPI_API_TOKEN}`,
    },
    body: form,
  });

  if (!uploadResponse.ok) {
    console.warn(`Strapi image upload failed: HTTP ${uploadResponse.status} ${await uploadResponse.text().catch(() => '')}`);
    return null;
  }

  const uploaded = await uploadResponse.json();
  return Array.isArray(uploaded) ? uploaded[0] || null : uploaded;
}

function fileExtensionForMime(mime: string) {
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('gif')) return 'gif';
  return 'png';
}

function safeFilename(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'commerce-product-image';
}

function absoluteStrapiUrl(value: string) {
  return value.startsWith('http') ? value : `${STRAPI_URL}${value}`;
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
