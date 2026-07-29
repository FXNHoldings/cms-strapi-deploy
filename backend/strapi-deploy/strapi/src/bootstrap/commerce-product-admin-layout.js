'use strict';

const COMMERCE_PRODUCT_UID = 'api::commerce-product.commerce-product';
const DESIRED_LIST_LAYOUT = ['documentId', 'primaryImage', 'name', 'brand', 'productStatus'];

function layoutsMatch(currentList, desiredList) {
  if (!Array.isArray(currentList) || currentList.length < desiredList.length) {
    return false;
  }

  return desiredList.every((field, index) => currentList[index] === field);
}

async function ensureCommerceProductAdminLayout(strapi) {
  const contentType = strapi.contentTypes[COMMERCE_PRODUCT_UID];
  if (!contentType) return;

  const contentTypeService = strapi.plugin('content-manager').service('content-types');
  const current = await contentTypeService.findConfiguration(contentType);
  const currentList = current?.layouts?.list || [];

  if (layoutsMatch(currentList, DESIRED_LIST_LAYOUT)) {
    return;
  }

  const metadatas = {
    ...current.metadatas,
    primaryImage: {
      edit: {
        visible: true,
        editable: true,
        label: 'Primary Image',
        ...(current.metadatas?.primaryImage?.edit || {}),
      },
      list: {
        label: 'Image',
        searchable: false,
        sortable: false,
        ...(current.metadatas?.primaryImage?.list || {}),
      },
    },
  };

  await contentTypeService.updateConfiguration(contentType, {
    settings: {
      ...current.settings,
      mainField: 'name',
    },
    metadatas,
    layouts: {
      edit: current.layouts?.edit || [],
      list: DESIRED_LIST_LAYOUT,
    },
  });

  strapi.log.info('[fxn-cms] Commerce product list view configured with image between ID and name.');
}

module.exports = {
  ensureCommerceProductAdminLayout,
};
