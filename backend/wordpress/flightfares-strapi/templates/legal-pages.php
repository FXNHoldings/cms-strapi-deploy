<?php
/**
 * WordPress page template backed by the Elementor "Legal Pages" saved template.
 */

if (!defined('ABSPATH')) {
    exit;
}

get_header();
?>
<main id="primary" class="site-main flightfares-legal-page-template">
    <?php
    while (have_posts()) {
        the_post();
        $content = apply_filters('the_content', get_the_content());
        ?>
        <style>
            .flightfares-legal-shell{max-width:1200px;margin:0 auto;padding:38px 20px 70px}
            .flightfares-legal-header{margin-bottom:30px}
            .flightfares-legal-header h1{font-size:36px;line-height:1.2;margin:0 0 12px;color:#111}
            .flightfares-legal-breadcrumbs{font-size:14px;color:#5f6672}
            .flightfares-legal-breadcrumbs a{color:#6d1898;text-decoration:none}
            .flightfares-template-layout{display:grid;grid-template-columns:minmax(220px,27%) minmax(0,1fr);gap:38px}
            .flightfares-template-toc{position:sticky;top:30px;align-self:start;background:#f5f6f8;border:1px solid #e4e6eb;border-radius:8px;padding:22px;max-height:calc(100vh - 60px);overflow:auto}
            .flightfares-template-toc strong{display:block;margin-bottom:12px;font-size:18px;color:#111}
            .flightfares-template-toc ol{margin:0;padding-left:20px}.flightfares-template-toc li{margin-bottom:9px}
            .flightfares-template-toc a{color:#27334a;text-decoration:none}.flightfares-template-toc a:hover{text-decoration:underline}
            .flightfares-template-content{min-width:0}.flightfares-template-content h2{font-size:26px;scroll-margin-top:90px}
            @media(max-width:767px){.flightfares-template-layout{display:block}.flightfares-template-toc{position:static;max-height:none;margin-bottom:24px}}
        </style>
        <div class="flightfares-legal-shell">
            <header class="flightfares-legal-header">
                <h1><?php echo esc_html(get_the_title()); ?></h1>
                <nav class="flightfares-legal-breadcrumbs" aria-label="<?php esc_attr_e('Breadcrumb', 'flightfares-strapi'); ?>">
                    <a href="<?php echo esc_url(home_url('/')); ?>"><?php esc_html_e('Home', 'flightfares-strapi'); ?></a>
                    <span aria-hidden="true"> / </span>
                    <span><?php echo esc_html(get_the_title()); ?></span>
                </nav>
            </header>
            <?php
            // Pages already authored with the legal layout keep their curated TOC.
            if (strpos($content, 'ff-legal-layout') !== false) {
                echo $content; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- Filtered by the_content.
                continue;
            }

            $toc = [];
            $used_ids = [];
            $content = preg_replace_callback(
                '/<h([23])([^>]*)>(.*?)<\/h\1>/is',
                function ($matches) use (&$toc, &$used_ids) {
                    $attributes = $matches[2];
                    $label = trim(wp_strip_all_tags($matches[3]));
                    if ($label === '') {
                        return $matches[0];
                    }

                    if (preg_match('/\sid=["\']([^"\']+)["\']/i', $attributes, $id_match)) {
                        $id = sanitize_title($id_match[1]);
                    } else {
                        $base_id = sanitize_title($label) ?: 'section';
                        $id = $base_id;
                        $suffix = 2;
                        while (isset($used_ids[$id])) {
                            $id = $base_id . '-' . $suffix++;
                        }
                        $attributes .= ' id="' . esc_attr($id) . '"';
                    }
                    $used_ids[$id] = true;
                    $toc[] = ['level' => (int) $matches[1], 'id' => $id, 'label' => $label];
                    return '<h' . $matches[1] . $attributes . '>' . $matches[3] . '</h' . $matches[1] . '>';
                },
                $content
            );
            ?>
            <div class="flightfares-template-layout">
                <aside class="flightfares-template-toc">
                    <strong><?php esc_html_e('Table of Contents', 'flightfares-strapi'); ?></strong>
                    <?php if ($toc) : ?>
                        <ol>
                            <?php foreach ($toc as $item) : ?>
                                <li class="toc-level-<?php echo esc_attr($item['level']); ?>">
                                    <a href="#<?php echo esc_attr($item['id']); ?>"><?php echo esc_html($item['label']); ?></a>
                                </li>
                            <?php endforeach; ?>
                        </ol>
                    <?php else : ?>
                        <p><?php esc_html_e('Add H2 or H3 headings to generate the table of contents.', 'flightfares-strapi'); ?></p>
                    <?php endif; ?>
                </aside>
                <article class="flightfares-template-content">
                    <?php echo $content; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- Filtered by the_content. ?>
                </article>
            </div>
        </div>
        <?php
    }
    ?>
</main>
<?php
get_footer();
