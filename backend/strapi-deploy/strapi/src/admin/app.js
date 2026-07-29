const COMMERCE_PRODUCT_UID = 'api::commerce-product.commerce-product';
const COMMERCE_PRODUCT_DISPLAY_NAME = 'Commerce · Product';

const INJECT_COLUMN_IN_TABLE = 'Admin/CM/pages/ListView/inject-column-in-table';
const MUTATE_EDIT_VIEW_LAYOUT = 'Admin/CM/pages/EditView/mutate-edit-view-layout';

function isCommerceProductLayout(layout) {
  return layout?.settings?.displayName === COMMERCE_PRODUCT_DISPLAY_NAME;
}

function buildPrimaryImageHeader() {
  return {
    attribute: { type: 'media', multiple: false },
    label: 'Image',
    name: 'primaryImage',
    searchable: false,
    sortable: false,
  };
}

function injectCommerceProductImageColumn({ displayedHeaders, layout }) {
  if (!isCommerceProductLayout(layout)) {
    return { displayedHeaders, layout };
  }

  if (displayedHeaders.some((header) => header.name === 'primaryImage')) {
    return { displayedHeaders, layout };
  }

  const idIndex = displayedHeaders.findIndex(
    (header) => header.name === 'documentId' || header.name === 'id',
  );
  const nameIndex = displayedHeaders.findIndex((header) => header.name === 'name');
  const insertAt = idIndex >= 0 ? idIndex + 1 : nameIndex >= 0 ? nameIndex : 0;

  const nextHeaders = [...displayedHeaders];
  nextHeaders.splice(insertAt, 0, buildPrimaryImageHeader());

  return { displayedHeaders: nextHeaders, layout };
}

function removeFieldFromPanels(panels, fieldName) {
  let removedField = null;

  const nextPanels = panels
    .map((panel) =>
      panel
        .map((row) =>
          row.filter((field) => {
            if (field.name === fieldName) {
              removedField = field;
              return false;
            }
            return true;
          }),
        )
        .filter((row) => row.length > 0),
    )
    .filter((panel) => panel.length > 0);

  return { panels: nextPanels, removedField };
}

function insertFieldBeforeName(panels, field) {
  if (!field) return panels;

  let inserted = false;
  const nextPanels = panels.map((panel) =>
    panel.map((row) => {
      if (inserted) return row;

      const nameIndex = row.findIndex((entry) => entry.name === 'name');
      if (nameIndex === -1) return row;

      inserted = true;
      const nextRow = [...row];
      nextRow.splice(nameIndex, 0, field);
      return nextRow;
    }),
  );

  if (inserted) return nextPanels;

  if (!nextPanels.length) {
    return [[[field]]];
  }

  nextPanels[0].unshift([field]);
  return nextPanels;
}

function mutateCommerceProductEditLayout(payload) {
  const { layout } = payload;
  if (!isCommerceProductLayout(layout) || !Array.isArray(layout.layout)) {
    return payload;
  }

  const { panels, removedField } = removeFieldFromPanels(layout.layout, 'primaryImage');
  const nextLayout = insertFieldBeforeName(panels, removedField);

  return {
    ...payload,
    layout: {
      ...layout,
      layout: nextLayout,
    },
  };
}

export default {
  config: {
    locales: [],
  },
  bootstrap(app) {
    app.registerHook(INJECT_COLUMN_IN_TABLE, injectCommerceProductImageColumn);
    app.registerHook(MUTATE_EDIT_VIEW_LAYOUT, mutateCommerceProductEditLayout);
  },
};
