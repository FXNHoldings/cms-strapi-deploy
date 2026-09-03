<?php
/**
 * Plugin Name: Flightfares Strapi Publisher
 * Description: Receives signed Strapi article webhooks and upserts WordPress posts.
 * Version: 2.0.0
 */

if (!defined('ABSPATH')) {
    exit;
}

const FLIGHTFARES_STRAPI_SECRET_OPTION = 'flightfares_strapi_webhook_secret';
const FLIGHTFARES_STRAPI_ID_META = '_flightfares_strapi_article_id';
const FLIGHTFARES_PILLAR_PAGE_META = '_flightfares_pillar_page';
const FLIGHTFARES_ELEMENTOR_LEGAL_TEMPLATE_ID = 1760;
const FLIGHTFARES_CLAUDE_SEO_SECRET_OPTION = 'flightfares_claude_seo_secret';

require_once plugin_dir_path(__FILE__) . 'includes/claude-content-assistant.php';

register_activation_hook(__FILE__, function () {
    if (!get_option(FLIGHTFARES_CLAUDE_SEO_SECRET_OPTION)) {
        update_option(FLIGHTFARES_CLAUDE_SEO_SECRET_OPTION, wp_generate_password(64, false, false), false);
    }
});

/*
 * Rank Math 1.0.277.1 can throw DivisionByZeroError in /an/dashboard when
 * Search Console is connected before the first impressions have been
 * imported. Return its normal empty-state shape until analytics rows exist.
 */
add_filter('rest_pre_dispatch', function ($result, $server, $request) {
    if ($request->get_route() !== '/rankmath/v1/an/dashboard' || $request->get_method() !== 'GET') {
        return $result;
    }

    if (!current_user_can('manage_options')) {
        return $result;
    }

    global $wpdb;
    $table = $wpdb->prefix . 'rank_math_analytics_gsc';
    $table_exists = $wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $table)) === $table;
    $has_impressions = false;

    if ($table_exists) {
        $has_impressions = (bool) $wpdb->get_var("SELECT 1 FROM `{$table}` WHERE impressions > 0 LIMIT 1");
    }

    if ($has_impressions) {
        return $result;
    }

    $empty_metric = [
        'total' => 'n/a',
        'previous' => 'n/a',
        'difference' => 'n/a',
    ];
    $optimization = (object) [];

    if (class_exists('RankMath\\Analytics\\Stats')) {
        $optimization = \RankMath\Analytics\Stats::get()->get_optimization_summary();
    }

    return rest_ensure_response([
        'stats' => [
            'clicks' => $empty_metric,
            'impressions' => $empty_metric,
            'position' => $empty_metric,
            'keywords' => $empty_metric,
            'ctr' => $empty_metric,
            'graph' => [
                'analytics' => [],
                'merged' => [],
            ],
        ],
        'optimization' => $optimization,
    ]);
}, 10, 3);

/* Make the legal layouts available in the Page > Template dropdown. */
add_filter('theme_page_templates', function ($templates) {
    $templates['flightfares-default-legal-page.php'] = __('Default Legal Pages', 'flightfares-strapi');
    $templates['flightfares-legal-pages.php'] = __('Legal Pages Template', 'flightfares-strapi');
    return $templates;
});

add_filter('template_include', function ($template) {
    if (!is_singular('page')) {
        return $template;
    }

    $selected = get_page_template_slug(get_queried_object_id());
    if ($selected === 'flightfares-default-legal-page.php') {
        $theme_template = locate_template(['page.php', 'singular.php', 'index.php']);
        return $theme_template ?: $template;
    }
    if ($selected === 'flightfares-legal-pages.php') {
        $legal_template = plugin_dir_path(__FILE__) . 'templates/legal-pages.php';
        return is_readable($legal_template) ? $legal_template : $template;
    }

    return $template;
}, 99);

add_action('init', function () {
    register_post_meta('page', FLIGHTFARES_PILLAR_PAGE_META, [
        'type' => 'boolean',
        'single' => true,
        'show_in_rest' => true,
        'auth_callback' => function () {
            return current_user_can('edit_pages');
        },
        'sanitize_callback' => 'rest_sanitize_boolean',
    ]);

    foreach (['post', 'page'] as $post_type) {
        foreach (['rank_math_title', 'rank_math_description', 'rank_math_focus_keyword'] as $meta_key) {
            register_post_meta($post_type, $meta_key, [
                'type' => 'string',
                'single' => true,
                'show_in_rest' => true,
                'sanitize_callback' => 'sanitize_text_field',
                'auth_callback' => function () {
                    return current_user_can('edit_posts') || current_user_can('edit_pages');
                },
            ]);
        }
    }
});

add_action('admin_init', function () {
    if (get_option('flightfares_admin_features_version') === '1.1.0') {
        return;
    }

    // Existing Flightfares cornerstone guides. Editors can change this setting
    // later from the Pillar Page box on each Page edit screen.
    foreach ([1633, 1644, 1649, 1650, 1651] as $page_id) {
        if (get_post_type($page_id) === 'page') {
            update_post_meta($page_id, FLIGHTFARES_PILLAR_PAGE_META, '1');
        }
    }
    update_option('flightfares_admin_features_version', '1.1.0', false);
});

/*
 * Editorial helpers for the WordPress admin list screens.
 * Pillar content remains a Page (rather than being mixed into the post query),
 * but editors can reach the filtered list directly from Posts > All Posts.
 */
add_filter('views_edit-post', function ($views) {
    $count = count(get_posts([
        'post_type' => 'page',
        'post_status' => ['publish', 'future', 'draft', 'pending', 'private'],
        'meta_key' => FLIGHTFARES_PILLAR_PAGE_META,
        'meta_value' => '1',
        'posts_per_page' => -1,
        'fields' => 'ids',
        'no_found_rows' => true,
    ]));

    $url = add_query_arg([
        'post_type' => 'page',
        'pillar_pages' => '1',
    ], admin_url('edit.php'));

    $views['flightfares_pillar_pages'] = sprintf(
        '<a href="%s">%s <span class="count">(%d)</span></a>',
        esc_url($url),
        esc_html__('Pillar Pages', 'flightfares-strapi'),
        $count
    );

    return $views;
});

add_action('pre_get_posts', function ($query) {
    if (!is_admin() || !$query->is_main_query()) {
        return;
    }

    if ($query->get('post_type') === 'page' && isset($_GET['pillar_pages'])) {
        $query->set('meta_key', FLIGHTFARES_PILLAR_PAGE_META);
        $query->set('meta_value', '1');
    }
});

add_action('add_meta_boxes_page', function () {
    add_meta_box(
        'flightfares-pillar-page',
        __('Pillar Page', 'flightfares-strapi'),
        function ($post) {
            wp_nonce_field('flightfares_save_pillar_page', 'flightfares_pillar_page_nonce');
            $checked = get_post_meta($post->ID, FLIGHTFARES_PILLAR_PAGE_META, true) === '1';
            echo '<label><input type="checkbox" name="flightfares_pillar_page" value="1" ';
            checked($checked);
            echo '> ' . esc_html__('Display this page in the Pillar Pages dashboard view', 'flightfares-strapi') . '</label>';
        },
        'page',
        'side',
        'high'
    );
});

add_action('save_post_page', function ($post_id) {
    if (!isset($_POST['flightfares_pillar_page_nonce']) ||
        !wp_verify_nonce(sanitize_text_field(wp_unslash($_POST['flightfares_pillar_page_nonce'])), 'flightfares_save_pillar_page') ||
        (defined('DOING_AUTOSAVE') && DOING_AUTOSAVE) ||
        !current_user_can('edit_page', $post_id)) {
        return;
    }

    if (isset($_POST['flightfares_pillar_page'])) {
        update_post_meta($post_id, FLIGHTFARES_PILLAR_PAGE_META, '1');
    } else {
        delete_post_meta($post_id, FLIGHTFARES_PILLAR_PAGE_META);
    }
});

function flightfares_add_featured_image_column($columns)
{
    $result = [];
    foreach ($columns as $key => $label) {
        $result[$key] = $label;
        if ($key === 'cb') {
            $result['flightfares_featured_image'] = __('Featured Image', 'flightfares-strapi');
        }
    }
    return $result;
}

function flightfares_render_featured_image_column($column, $post_id)
{
    if ($column !== 'flightfares_featured_image') {
        return;
    }

    if (has_post_thumbnail($post_id)) {
        echo get_the_post_thumbnail($post_id, [72, 48], [
            'style' => 'width:72px;height:48px;object-fit:cover;border-radius:4px;',
            'loading' => 'lazy',
        ]);
    } else {
        echo '<span aria-hidden="true">&mdash;</span><span class="screen-reader-text">' .
            esc_html__('No featured image', 'flightfares-strapi') . '</span>';
    }
}

add_filter('manage_posts_columns', 'flightfares_add_featured_image_column');
add_filter('manage_pages_columns', 'flightfares_add_featured_image_column');
add_action('manage_posts_custom_column', 'flightfares_render_featured_image_column', 10, 2);
add_action('manage_pages_custom_column', 'flightfares_render_featured_image_column', 10, 2);

add_action('admin_head-edit.php', function () {
    echo '<style>.column-flightfares_featured_image{width:92px}.column-flightfares_featured_image img{display:block}</style>';
});

add_action('rest_api_init', function () {
    register_rest_route('flightfares-strapi/v1', '/article', [
        'methods' => 'POST',
        'callback' => 'flightfares_strapi_receive_article',
        'permission_callback' => 'flightfares_strapi_verify_signature',
    ]);

    register_rest_route('flightfares-strapi/v1', '/claude-seo', [
        'methods' => 'POST',
        'callback' => 'flightfares_claude_seo_generate',
        'permission_callback' => function (WP_REST_Request $request) {
            $post_id = (int) $request->get_param('postId');
            return $post_id > 0 && current_user_can('edit_post', $post_id);
        },
    ]);

    register_rest_route('flightfares-strapi/v1', '/claude-seo/config', [
        'methods' => 'GET',
        'callback' => function () {
            $secret = (string) get_option(FLIGHTFARES_CLAUDE_SEO_SECRET_OPTION, '');
            if ($secret === '') {
                $secret = wp_generate_password(64, false, false);
                update_option(FLIGHTFARES_CLAUDE_SEO_SECRET_OPTION, $secret, false);
            }
            return new WP_REST_Response(['secret' => $secret], 200);
        },
        'permission_callback' => function () {
            return current_user_can('manage_options');
        },
    ]);
});

function flightfares_claude_seo_generate(WP_REST_Request $request)
{
    $post_id = (int) $request->get_param('postId');
    $post = get_post($post_id);
    if (!$post || !in_array($post->post_type, ['post', 'page'], true)) {
        return new WP_Error('invalid_post', 'A valid post or page is required.', ['status' => 400]);
    }

    $secret = (string) get_option(FLIGHTFARES_CLAUDE_SEO_SECRET_OPTION, '');
    if ($secret === '') {
        return new WP_Error('claude_not_configured', 'Claude SEO has not been configured.', ['status' => 503]);
    }

    $submitted = $request->get_param('suggestion');
    $result = null;
    if ($request->get_param('apply') && is_array($submitted)) {
        $result = $submitted;
    }

    $internal_links = [];
    foreach (get_posts(['post_type' => ['post', 'page'], 'post_status' => 'publish', 'posts_per_page' => 40, 'orderby' => 'modified', 'order' => 'DESC']) as $linked_post) {
        if ((int) $linked_post->ID !== $post_id) {
            $internal_links[] = ['title' => get_the_title($linked_post), 'url' => get_permalink($linked_post)];
        }
    }

    if ($result === null) {
    $response = wp_remote_post('https://cms.fxnstudio.com/api/claude-seo/generate', [
        'timeout' => 180,
        'headers' => [
            'Content-Type' => 'application/json',
            'X-Flightfares-Claude-Secret' => $secret,
        ],
        'body' => wp_json_encode([
            'title' => get_the_title($post),
            'currentSlug' => $post->post_name,
            'content' => $post->post_content,
            'excerpt' => wp_strip_all_tags($post->post_excerpt),
            'currentSeoTitle' => get_post_meta($post_id, 'rank_math_title', true),
            'currentSeoDescription' => get_post_meta($post_id, 'rank_math_description', true),
            'currentFocusKeyword' => get_post_meta($post_id, 'rank_math_focus_keyword', true),
            'mode' => $request->get_param('mode') === 'optimize' ? 'optimize' : 'metadata',
            'task' => sanitize_key($request->get_param('task') ?: 'full'),
            'internalLinks' => $internal_links,
        ]),
    ]);
    if (is_wp_error($response)) {
        return new WP_Error('claude_request_failed', $response->get_error_message(), ['status' => 502]);
    }

    $status = wp_remote_retrieve_response_code($response);
    $result = json_decode(wp_remote_retrieve_body($response), true);
    if ($status < 200 || $status >= 300 || !is_array($result)) {
        $message = is_array($result) && !empty($result['error']['message'])
            ? $result['error']['message']
            : (is_array($result) && is_string($result['error'] ?? null) ? $result['error'] : 'Claude SEO request failed.');
        return new WP_Error('claude_request_failed', sanitize_text_field($message), ['status' => 502]);
    }
    }

    $seo = [
        'seoTitle' => sanitize_text_field($result['seoTitle'] ?? ''),
        'seoSlug' => sanitize_title($result['seoSlug'] ?? ''),
        'seoDescription' => sanitize_text_field($result['seoDescription'] ?? ''),
        'focusKeyword' => sanitize_text_field($result['focusKeyword'] ?? ''),
        'imageAlt' => sanitize_text_field($result['imageAlt'] ?? ''),
        'contentPatches' => [],
        'checks' => [],
        'recommendations' => array_map('sanitize_text_field', is_array($result['recommendations'] ?? null) ? $result['recommendations'] : []),
    ];
    foreach (is_array($result['contentPatches'] ?? null) ? array_slice($result['contentPatches'], 0, 8) : [] as $patch) {
        $find = isset($patch['find']) ? (string) $patch['find'] : '';
        $replace = isset($patch['replace']) ? wp_kses_post($patch['replace']) : '';
        if ($find !== '' && $replace !== '' && strlen($find) <= 2000) {
            $seo['contentPatches'][] = ['find' => $find, 'replace' => $replace];
        }
    }
    foreach (['basicSeo', 'additionalSeo', 'titleReadability'] as $group) {
        $seo['checks'][$group] = array_map('sanitize_text_field', is_array($result['checks'][$group] ?? null) ? $result['checks'][$group] : []);
    }
    if ($request->get_param('apply')) {
        update_post_meta($post_id, 'rank_math_title', $seo['seoTitle']);
        update_post_meta($post_id, 'rank_math_description', $seo['seoDescription']);
        update_post_meta($post_id, 'rank_math_focus_keyword', $seo['focusKeyword']);
        if ($request->get_param('mode') === 'optimize' && $seo['contentPatches']) {
            $patched_content = $post->post_content;
            $applied_patches = 0;
            foreach ($seo['contentPatches'] as $content_patch) {
                $pattern = '/' . preg_quote($content_patch['find'], '/') . '/';
                $patched_content = preg_replace($pattern, addcslashes($content_patch['replace'], '\\$'), $patched_content, 1, $count);
                $applied_patches += (int) $count;
            }
            $updated = wp_update_post(['ID' => $post_id, 'post_content' => wp_slash($patched_content)], true);
            if (is_wp_error($updated)) {
                return $updated;
            }
            $seo['contentApplied'] = true;
            $seo['appliedPatches'] = $applied_patches;
        }
        if ($request->get_param('mode') === 'optimize' && $seo['imageAlt'] !== '') {
            $thumbnail_id = get_post_thumbnail_id($post_id);
            if ($thumbnail_id) {
                update_post_meta($thumbnail_id, '_wp_attachment_image_alt', $seo['imageAlt']);
                $seo['imageAltApplied'] = true;
            }
        }
        if ($request->get_param('applySlug') && $seo['seoSlug'] !== '' && $seo['seoSlug'] !== $post->post_name) {
            $updated = wp_update_post(['ID' => $post_id, 'post_name' => $seo['seoSlug']], true);
            if (is_wp_error($updated)) {
                return $updated;
            }
            $seo['slugApplied'] = true;
        }
        clean_post_cache($post_id);
        $seo['applied'] = true;
    }
    return new WP_REST_Response($seo, 200);
}

add_action('add_meta_boxes', function () {
    foreach (['post', 'page'] as $post_type) {
        add_meta_box('flightfares-claude-seo', 'Claude SEO', 'flightfares_render_claude_seo_box', $post_type, 'side', 'high');
    }
});

function flightfares_render_claude_seo_box($post)
{
    echo '<p>Generate Rank Math metadata with Claude Sonnet.</p>';
    echo '<p><button type="button" class="button button-primary ff-claude-action" data-mode="metadata" data-task="snippet">Generate Snippet</button></p>';
    echo '<p><button type="button" class="button ff-claude-action" data-mode="optimize" data-task="basic">Fix Basic SEO</button> ';
    echo '<button type="button" class="button ff-claude-action" data-mode="optimize" data-task="additional">Fix Additional SEO</button></p>';
    echo '<p><button type="button" class="button ff-claude-action" data-mode="optimize" data-task="title">Improve Title Readability</button></p>';
    echo '<p><button type="button" class="button button-secondary ff-claude-action" data-mode="optimize" data-task="full">Run Full SEO Audit</button></p>';
    echo '<button type="button" class="button" id="ff-claude-seo-apply" disabled>Apply to Rank Math</button>';
    echo '<p><label><input type="checkbox" id="ff-claude-seo-apply-slug"> Also update permalink</label><br><small>Leave unchecked for published URLs unless you intend to change them.</small></p>';
    echo '<div id="ff-claude-seo-status" style="margin-top:10px" aria-live="polite"></div>';
    echo '<div id="ff-claude-seo-results" style="margin-top:10px"></div>';
}

add_action('admin_footer-post.php', 'flightfares_claude_seo_admin_script');
add_action('admin_footer-post-new.php', 'flightfares_claude_seo_admin_script');

function flightfares_claude_seo_admin_script()
{
    global $post;
    if (!$post || !in_array($post->post_type, ['post', 'page'], true)) return;
    $endpoint = rest_url('flightfares-strapi/v1/claude-seo');
    $nonce = wp_create_nonce('wp_rest');
    ?>
    <script>
    (() => {
      const postId = <?php echo (int) $post->ID; ?>;
      const endpoint = <?php echo wp_json_encode($endpoint); ?>;
      const nonce = <?php echo wp_json_encode($nonce); ?>;
      let suggestion = null;
      const status = () => document.getElementById('ff-claude-seo-status');
      const results = () => document.getElementById('ff-claude-seo-results');
      const applyButton = () => document.getElementById('ff-claude-seo-apply');
      let mode = 'metadata';
      let task = 'snippet';
      async function request(apply, requestedMode, requestedTask) {
        if (requestedMode) mode = requestedMode;
        if (requestedTask) task = requestedTask;
        status().textContent = apply ? 'Applying selected fixes to Rank Math…' : 'Claude is running ' + task + '…';
        const applySlug = !!document.getElementById('ff-claude-seo-apply-slug')?.checked;
        const response = await fetch(endpoint, {method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-WP-Nonce':nonce},body:JSON.stringify({postId,apply,applySlug,mode,task,suggestion:apply?suggestion:null})});
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Claude SEO request failed.');
        suggestion = data;
        const groups = data.checks || {};
        const groupHtml = [['basicSeo','Basic SEO'],['additionalSeo','Additional'],['titleReadability','Title Readability']].map(([key,label]) => (groups[key]||[]).length ? '<details open><summary><strong>'+label+' ('+groups[key].length+')</strong></summary><ul><li>'+groups[key].map(escapeHtml).join('</li><li>')+'</li></ul></details>' : '').join('');
        results().innerHTML = '<p><strong>SEO title</strong><br>' + escapeHtml(data.seoTitle) + '</p><p><strong>Permalink</strong><br>' + escapeHtml(data.seoSlug) + '</p><p><strong>Meta description</strong><br>' + escapeHtml(data.seoDescription) + '</p><p><strong>Focus keyphrase</strong><br>' + escapeHtml(data.focusKeyword) + '</p><p><strong>Featured-image alt</strong><br>'+escapeHtml(data.imageAlt)+'</p>'+groupHtml+((data.contentPatches||[]).length?'<p><strong>Targeted content edits:</strong> '+data.contentPatches.length+'</p>':'')+((data.recommendations||[]).length ? '<details><summary><strong>Needs review ('+data.recommendations.length+')</strong></summary><ul><li>' + data.recommendations.map(escapeHtml).join('</li><li>') + '</li></ul></details>' : '');
        applyButton().disabled = false;
        status().textContent = data.applied ? 'Applied to Rank Math. Reload the editor to refresh Rank Math previews.' : 'Review the suggestion, then apply it.';
      }
      const escapeHtml = value => String(value || '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c]));
      document.querySelectorAll('.ff-claude-action').forEach(button => button.addEventListener('click', () => request(false, button.dataset.mode, button.dataset.task).catch(e => status().textContent=e.message)));
      applyButton()?.addEventListener('click', () => suggestion && request(true, mode, task).catch(e => status().textContent=e.message));
      const hideRankMathAi = () => document.querySelectorAll('button,a').forEach(el => { const text=(el.textContent||'').trim(); if (/^(Write with AI|Content AI|Generate with AI|Research)$/i.test(text)) el.style.display='none'; });
      hideRankMathAi(); new MutationObserver(hideRankMathAi).observe(document.body,{childList:true,subtree:true});
    })();
    </script>
    <?php
}

function flightfares_strapi_verify_signature(WP_REST_Request $request)
{
    $secret = (string) get_option(FLIGHTFARES_STRAPI_SECRET_OPTION, '');
    $signature = (string) $request->get_header('x-fxn-signature');

    if ($secret === '' || $signature === '') {
        return new WP_Error('missing_signature', 'Webhook signature is required.', ['status' => 401]);
    }

    $expected = hash_hmac('sha256', $request->get_body(), $secret);
    if (!hash_equals($expected, $signature)) {
        return new WP_Error('invalid_signature', 'Webhook signature is invalid.', ['status' => 403]);
    }

    return true;
}

function flightfares_strapi_receive_article(WP_REST_Request $request)
{
    $payload = $request->get_json_params();
    $article = isset($payload['article']) && is_array($payload['article']) ? $payload['article'] : [];

    if (($payload['event'] ?? '') !== 'article.published' || empty($article['id']) || empty($article['title']) || empty($article['slug'])) {
        return new WP_Error('invalid_payload', 'A valid published article payload is required.', ['status' => 400]);
    }

    $existing = get_posts([
        'post_type' => 'post',
        'post_status' => 'any',
        'meta_key' => FLIGHTFARES_STRAPI_ID_META,
        'meta_value' => sanitize_text_field((string) $article['id']),
        'posts_per_page' => 1,
        'fields' => 'ids',
    ]);
    if (!$existing && !empty($article['legacyWpId'])) {
        $legacy_post = get_post((int) $article['legacyWpId']);
        if ($legacy_post && $legacy_post->post_type === 'post') {
            $existing = [(int) $legacy_post->ID];
        }
    }
    if (!$existing) {
        $slug_post = get_page_by_path(sanitize_title($article['slug']), OBJECT, 'post');
        if ($slug_post) {
            $existing = [(int) $slug_post->ID];
        }
    }

    $post_data = [
        'post_type' => 'post',
        'post_status' => ($payload['mode'] ?? '') === 'test' ? 'draft' : 'publish',
        'post_title' => sanitize_text_field($article['title']),
        'post_name' => sanitize_title($article['slug']),
        'post_excerpt' => sanitize_textarea_field($article['excerpt'] ?? ''),
        'post_content' => wp_kses_post($article['contentHtml'] ?? $article['content'] ?? ''),
    ];
    if ($existing) {
        $post_data['ID'] = (int) $existing[0];
    }

    $post_id = wp_insert_post(wp_slash($post_data), true);
    if (is_wp_error($post_id)) {
        return $post_id;
    }

    update_post_meta($post_id, FLIGHTFARES_STRAPI_ID_META, sanitize_text_field((string) $article['id']));
    if (!empty($article['seoTitle'])) {
        update_post_meta($post_id, 'rank_math_title', sanitize_text_field($article['seoTitle']));
    }
    if (!empty($article['seoDescription'])) {
        update_post_meta($post_id, 'rank_math_description', sanitize_text_field($article['seoDescription']));
    }
    if (!empty($article['seoKeywords'])) {
        $keywords = array_filter(array_map('trim', explode(',', (string) $article['seoKeywords'])));
        if ($keywords) {
            update_post_meta($post_id, 'rank_math_focus_keyword', sanitize_text_field($keywords[0]));
        }
    }
    flightfares_strapi_set_taxonomy($post_id, 'category', array_filter([$article['category'] ?? null]));
    flightfares_strapi_set_taxonomy($post_id, 'post_tag', $article['tags'] ?? []);

    if (!empty($article['coverImage']) && !get_post_thumbnail_id($post_id)) {
        flightfares_strapi_set_featured_image($post_id, esc_url_raw($article['coverImage']));
    }

    clean_post_cache($post_id);
    return new WP_REST_Response([
        'ok' => true,
        'postId' => $post_id,
        'url' => get_permalink($post_id),
        'action' => $existing ? 'updated' : 'created',
    ], $existing ? 200 : 201);
}

function flightfares_strapi_set_taxonomy($post_id, $taxonomy, $names)
{
    if (!is_array($names)) {
        return;
    }

    $term_ids = [];
    foreach ($names as $name) {
        $name = sanitize_text_field((string) $name);
        if ($name === '') {
            continue;
        }
        $term = term_exists($name, $taxonomy);
        if (!$term) {
            $term = wp_insert_term($name, $taxonomy);
        }
        if (!is_wp_error($term)) {
            $term_ids[] = (int) (is_array($term) ? $term['term_id'] : $term);
        }
    }
    if ($term_ids) {
        wp_set_object_terms($post_id, $term_ids, $taxonomy, false);
    }
}

function flightfares_strapi_set_featured_image($post_id, $url)
{
    require_once ABSPATH . 'wp-admin/includes/file.php';
    require_once ABSPATH . 'wp-admin/includes/media.php';
    require_once ABSPATH . 'wp-admin/includes/image.php';

    $attachment_id = media_sideload_image($url, $post_id, null, 'id');
    if (!is_wp_error($attachment_id)) {
        set_post_thumbnail($post_id, $attachment_id);
    }
}
