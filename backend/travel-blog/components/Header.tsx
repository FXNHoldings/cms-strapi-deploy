import Link from 'next/link';
import { listCategories, type StrapiCategory } from '@/lib/strapi';
import { SECTIONS } from '@/lib/sections';

type TreeNode = StrapiCategory & { children: TreeNode[] };

/** Build a nested tree from Strapi's flat category list using `parent.id` refs. */
function buildTree(cats: StrapiCategory[]): TreeNode[] {
  const byId = new Map<number, TreeNode>();
  cats.forEach((c) => byId.set(c.id, { ...c, children: [] }));

  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const parentId = node.parent?.id;
    if (parentId && byId.has(parentId)) {
      byId.get(parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sort = (nodes: TreeNode[]) => {
    nodes.sort(
      (a, b) => (a.order ?? 9999) - (b.order ?? 9999) || a.name.localeCompare(b.name),
    );
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

export default async function Header() {
  let cats: StrapiCategory[] = [];
  try { cats = await listCategories(); } catch { /* Strapi down — render without nav */ }

  const tree = buildTree(cats);
  const bySlug = new Map(tree.map((n) => [n.slug.toLowerCase(), n]));

  return (
    <header
      className="sticky top-0 z-50 border-b border-forest-900/10 bg-paper/85 backdrop-blur"
      data-testid="site-header"
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-baseline gap-2" data-testid="logo-link">
          <span className="font-urbanist text-2xl font-black text-forest-900">FXN</span>
          <span className="font-urbanist text-xl font-light text-forest-800">Studio</span>
        </Link>

        <nav className="hidden md:block" data-testid="primary-nav">
          <ul className="flex items-center gap-1 text-sm font-medium">
            {SECTIONS.map((section) => {
              const match = bySlug.get(section.slug.toLowerCase());
              const children = match?.children ?? [];
              return (
                <NavTopItem
                  key={section.slug}
                  slug={section.slug}
                  title={section.title}
                  children={children}
                />
              );
            })}
          </ul>
        </nav>
      </div>
    </header>
  );
}

function NavTopItem({
  slug,
  title,
  children,
}: {
  slug: string;
  title: string;
  children: TreeNode[];
}) {
  const hasChildren = children.length > 0;
  return (
    // `group/nav` + named Tailwind group makes nested hover behave predictably
    <li
      className="group/nav relative"
      data-testid={`nav-item-${slug}`}
    >
      <Link
        href={`/category/${slug}`}
        className="inline-flex items-center gap-1.5 px-3 py-2 text-forest-800 transition-colors hover:text-terracotta-700"
        data-testid={`nav-${slug}`}
      >
        {title}
        {hasChildren && <Caret />}
      </Link>

      {hasChildren && (
        <ul
          className="
            invisible absolute left-0 top-full z-50 mt-1 min-w-[240px]
            rounded-xl border border-forest-900/10 bg-paper py-2 shadow-xl
            opacity-0 translate-y-1
            transition-all duration-150
            group-hover/nav:visible group-hover/nav:opacity-100 group-hover/nav:translate-y-0
          "
          data-testid={`nav-dropdown-${slug}`}
        >
          {children.map((c) => <SubItem key={c.id} node={c} />)}
        </ul>
      )}
    </li>
  );
}

/**
 * Recursive sub-item — uses Tailwind's arbitrary variant `[&:hover>ul]:...`
 * to open the next level on hover, at any depth.
 */
function SubItem({ node }: { node: TreeNode }) {
  const hasChildren = node.children.length > 0;
  return (
    <li
      className="relative [&:hover>ul]:visible [&:hover>ul]:opacity-100 [&:hover>ul]:translate-x-0"
      data-testid={`nav-sub-${node.slug}`}
    >
      <Link
        href={`/category/${node.slug}`}
        className="flex items-center justify-between gap-6 px-4 py-2 text-sm text-forest-800 transition hover:bg-sand-50 hover:text-terracotta-700"
      >
        <span>{node.name}</span>
        {hasChildren && <span className="text-xs opacity-40">›</span>}
      </Link>

      {hasChildren && (
        <ul
          className="
            invisible absolute left-full top-0 z-50 ml-1 min-w-[220px]
            rounded-xl border border-forest-900/10 bg-paper py-2 shadow-xl
            opacity-0 -translate-x-1
            transition-all duration-150
          "
        >
          {node.children.map((c) => <SubItem key={c.id} node={c} />)}
        </ul>
      )}
    </li>
  );
}

function Caret() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden
      className="opacity-60 transition-transform group-hover/nav:rotate-180"
    >
      <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
