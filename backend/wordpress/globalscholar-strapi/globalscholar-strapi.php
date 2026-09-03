<?php
/**
 * Plugin Name: GlobalScholar Strapi Publisher
 * Description: Receives signed Strapi article webhooks and upserts WordPress posts.
 * Version: 1.0.0
 */

if (!defined('ABSPATH')) {
    exit;
}

const GLOBALSCHOLAR_STRAPI_SECRET_OPTION = 'globalscholar_strapi_webhook_secret';
const GLOBALSCHOLAR_STRAPI_ID_META = '_globalscholar_strapi_article_id';

add_action('rest_api_init', function () {
    register_rest_route('globalscholar-strapi/v1', '/article', [
        'methods' => 'POST',
        'callback' => 'globalscholar_strapi_receive_article',
        'permission_callback' => 'globalscholar_strapi_verify_signature',
    ]);
});

function globalscholar_strapi_verify_signature(WP_REST_Request $request)
{
    $secret = (string) get_option(GLOBALSCHOLAR_STRAPI_SECRET_OPTION, '');
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

function globalscholar_strapi_receive_article(WP_REST_Request $request)
{
    $payload = $request->get_json_params();
    $article = isset($payload['article']) && is_array($payload['article']) ? $payload['article'] : [];

    if (($payload['event'] ?? '') !== 'article.published' || empty($article['id']) || empty($article['title']) || empty($article['slug'])) {
        return new WP_Error('invalid_payload', 'A valid published article payload is required.', ['status' => 400]);
    }

    $existing = get_posts([
        'post_type' => 'post',
        'post_status' => 'any',
        'meta_key' => GLOBALSCHOLAR_STRAPI_ID_META,
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

    update_post_meta($post_id, GLOBALSCHOLAR_STRAPI_ID_META, sanitize_text_field((string) $article['id']));
    globalscholar_strapi_set_taxonomy($post_id, 'category', array_filter([$article['category'] ?? null]));
    globalscholar_strapi_set_taxonomy($post_id, 'post_tag', $article['tags'] ?? []);

    if (!empty($article['coverImage']) && !get_post_thumbnail_id($post_id)) {
        globalscholar_strapi_set_featured_image($post_id, esc_url_raw($article['coverImage']));
    }

    clean_post_cache($post_id);
    return new WP_REST_Response([
        'ok' => true,
        'postId' => $post_id,
        'url' => get_permalink($post_id),
        'action' => $existing ? 'updated' : 'created',
    ], $existing ? 200 : 201);
}

function globalscholar_strapi_set_taxonomy($post_id, $taxonomy, $names)
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

function globalscholar_strapi_set_featured_image($post_id, $url)
{
    require_once ABSPATH . 'wp-admin/includes/file.php';
    require_once ABSPATH . 'wp-admin/includes/media.php';
    require_once ABSPATH . 'wp-admin/includes/image.php';

    $attachment_id = media_sideload_image($url, $post_id, null, 'id');
    if (!is_wp_error($attachment_id)) {
        set_post_thumbnail($post_id, $attachment_id);
    }
}
