<?php
// admin_handler.php
global $conn, $telegram, $resultTelegram, $chat_id, $mesasge_id;

/* ------------------ Logger ساده ------------------ */
function log_tg($msg)
{
    $line = '[' . date('c') . "] " . $msg . "\n";
    @file_put_contents(__DIR__ . '/tg.log', $line, FILE_APPEND);
}

/* --- نرمال‌سازی آپدیت: chat_id/message_id و callback_data --- */
$update = $resultTelegram ?? [];

if (isset($update['callback_query'])) {
    $chat_id = $update['callback_query']['message']['chat']['id'] ?? $chat_id;
    $mesasge_id = $update['callback_query']['message']['message_id'] ?? $mesasge_id;
}

$callback_data = null;
if (is_object($telegram) && method_exists($telegram, 'Callback_Data')) {
    $callback_data = $telegram->Callback_Data();
}
if (!$callback_data) {
    $callback_data = $update['callback_query']['data'] ?? null;
}

$text_message = null;
if (is_object($telegram) && method_exists($telegram, 'Text')) {
    $text_message = $telegram->Text();
} else {
    $text_message = $update['message']['text'] ?? null;
}


/* ======================================================================
   پردازش دکمه‌های شیشه‌ای (Callback Query)
   ====================================================================== */
if ($callback_data) {
    log_tg("CB_RECEIVED: chat={$chat_id} data={$callback_data}");

    // منوی روت داخلی ما
    if ($callback_data === 'admin_root') {
        sendAdminRootMenu($chat_id, $mesasge_id);
        exit;
    }

    // ناوبری اصلی (سازگاری با قبل)
    if ($callback_data === 'admin_panel' || $callback_data === 'start') {
        if ($callback_data === 'start')
            sendMainKeyboardMenu($chat_id, $mesasge_id);
        else
            sendAdminRootMenu($chat_id, $mesasge_id); // به‌جای منوی قدیمی
        log_tg("CB_HANDLED: open_menu {$callback_data}");
        exit;
    }

    // آمار
    if ($callback_data === 'admin_stats') {
        // آمار کلی
        $users_count      = (int)$conn->query("SELECT count(*) FROM users")->fetchColumn();
        $products_count   = (int)$conn->query("SELECT count(*) FROM products")->fetchColumn();
        
        // برای آمار دقیق‌تر، سفارشات موفق را شامل payed, approved, sending در نظر می‌گیریم
        $successful_statuses = "'payed', 'approved', 'sending'";
        $completed_orders = (int)$conn->query("SELECT count(*) FROM orders WHERE status IN ($successful_statuses)")->fetchColumn();
    
        // --- محاسبه درآمد ---
        
        // ۱. محدوده‌های زمانی را تعریف می‌کنیم (بر اساس تایم استمپ)
        $start_of_today = strtotime('today', time());
        $start_of_month = strtotime('first day of this month', time());
    
        // ۲. کوئری محاسبه درآمد را آماده می‌کنیم
        $sql_income = "SELECT SUM(oi.price * oi.quantity)
                       FROM orders_item oi
                       JOIN orders o ON oi.order_id = o.id
                       WHERE o.status IN ($successful_statuses)
                       AND o.time >= :start_timestamp";
        
        $stmt_income = $conn->prepare($sql_income);
    
        // ۳. درآمد امروز را محاسبه می‌کنیم
        $stmt_income->execute([':start_timestamp' => $start_of_today]);
        $daily_income = (int)$stmt_income->fetchColumn();
    
        // ۴. درآمد این ماه را محاسبه می‌کنیم
        $stmt_income->execute([':start_timestamp' => $start_of_month]);
        $monthly_income = (int)$stmt_income->fetchColumn();
        
        // --- ساخت متن پیام ---
    
        $stats_text  = "📊 <b>آمار کلی ربات:</b>\n\n";
        $stats_text .= "👤 کاربران: <b>{$users_count}</b>\n";
        $stats_text .= "📦 محصولات: <b>{$products_count}</b>\n";
        $stats_text .= "✅ سفارشات موفق: <b>{$completed_orders}</b>\n";
        $stats_text .= "─────────────────\n";
        $stats_text .= "💰 <b>عملکرد مالی:</b>\n\n";
        $stats_text .= "☀️ درآمد امروز: <b>" . number_format($daily_income) . " تومان</b>\n";
        $stats_text .= "🌙 درآمد این ماه: <b>" . number_format($monthly_income) . " تومان</b>\n";
    
        $keyb = build_back_to_admin_panel_inline();
        sendMessage($chat_id, $stats_text, $keyb, $mesasge_id);
        log_tg("CB_HANDLED: admin_stats");
        exit;
    }



    // --- Settings Management ---
    if ($callback_data === 'admin_settings_menu') {
        sendAdminSettingsMenu($chat_id, $mesasge_id);
        exit;
    }

    $settings_map = [
        'admin_edit_help'    => ['key' => 'help_text',    'prompt' => 'لطفاً متن جدید **راهنما** را ارسال کنید:'],
        'admin_edit_support' => ['key' => 'support_text', 'prompt' => 'لطفاً متن جدید **پشتیبانی** را ارسال کنید:'],
        'admin_edit_bank'    => ['key' => 'bank_info',    'prompt' => 'لطفاً اطلاعات جدید **شماره کارت** را ارسال کنید:'],
    ];

    if (isset($settings_map[$callback_data])) {
        $setting_info = $settings_map[$callback_data];
        $setting_key_to_edit = $setting_info['key'];
        $prompt_message = $setting_info['prompt'];
        
        query("CREATE", "admin_process_state", [
            "admin_user_id" => $chat_id,
            "process_name"  => "edit_setting",
            "step"          => "await_value",
            "step_data"     => json_encode(["key" => $setting_key_to_edit]) // کلید ثابت را ذخیره می‌کنیم
        ]);
        
        sendMessage($chat_id, $prompt_message . "\n\n(برای لغو /cancel)");
        exit;
    }


    if ($callback_data === 'admin_manage_faqs') {
        listFaqsManage($chat_id, $mesasge_id);
        exit;
    }

    if (strpos($callback_data, 'admin_toggle_faq_') === 0) {
        $fid = (int)str_replace('admin_toggle_faq_', '', $callback_data);
        $faq = query("SELECT","faqs",false,[["key"=>"id","condition"=>"=","value"=>$fid]]);
        if ($faq) {
            $new = ($faq->status==='enable'?'disable':'enable');
            query("UPDATE","faqs",["status"=>$new],[["key"=>"id","condition"=>"=","value"=>$fid]]);
            sendMessage($chat_id,"✅ وضعیت سوال به <b>{$new}</b> تغییر کرد.");
            listFaqsManage($chat_id);
        }
        exit;
    }

    if ($callback_data === 'admin_add_faq') {
        $stmt = $conn->prepare("DELETE FROM admin_process_state WHERE admin_user_id = :cid");
        $stmt->execute([':cid' => $chat_id]);
        query("CREATE", "admin_process_state", [
            "admin_user_id" => $chat_id,
            "process_name"  => "add_faq",
            "step"          => 1
        ]);
        sendMessage($chat_id, "<b>مرحله ۱: افزودن سوال</b>\n\nلطفاً «سوال» را به صورت کامل وارد کنید:\n(برای لغو /cancel)");
        exit;
    }

    // --- START: Category Deletion Process ---

    // Step 1: Admin clicks "Delete Category", we show the list.
    if ($callback_data === 'admin_delete_category') {
        sendAdminCategoryListToDelete($chat_id, $mesasge_id);
        exit;
    }

    // Step 2: Admin selects a category, we show confirmation.
    if (strpos($callback_data, 'admin_delete_category_select_') === 0) {
        $cat_id = (int) str_replace('admin_delete_category_select_', '', $callback_data);
        $category = query("SELECT", "categories", false, [["key" => "id", "condition" => "=", "value" => $cat_id]]);

        if (!$category) {
            sendMessage($chat_id, "❌ دسته‌بندی یافت نشد.", false, $mesasge_id);
            exit;
        }

        // IMPORTANT SAFETY CHECK: Check if any products exist in this category.
        $products_in_cat = query("SELECT", "products", false, [["key" => "category_id", "condition" => "=", "value" => $cat_id]]);

        if ($products_in_cat) {
            $text = "🚫 **امکان حذف وجود ندارد!**\n\n";
            $text .= "دسته‌بندی «**" . htmlspecialchars($category->name) . "**» قابل حذف نیست، زیرا هنوز محصولاتی در آن وجود دارد.\n\n";
            $text .= "ابتدا باید تمام محصولات این دسته‌بندی را حذف کرده یا به دسته‌بندی دیگری منتقل کنید.";
            $keyb = $telegram->buildInlineKeyBoard([
                [$telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_delete_category')]
            ]);
            sendMessage($chat_id, $text, $keyb, $mesasge_id);
        } else {
            $text = "❓ **آیا از حذف دسته‌بندی زیر اطمینان دارید؟**\n\n";
            $text .= "<b>" . htmlspecialchars($category->name) . "</b>\n\n";
            $text .= "این عمل غیرقابل بازگشت است.";
            $keyb = $telegram->buildInlineKeyBoard([
                [$telegram->buildInlineKeyBoardButton("✅ بله، حذف کن", '', 'admin_delete_category_confirm_' . $cat_id)],
                [$telegram->buildInlineKeyBoardButton("❌ خیر، منصرف شدم", '', 'admin_delete_category')]
            ]);
            sendMessage($chat_id, $text, $keyb, $mesasge_id);
        }
        exit;
    }

    // Step 3: Admin confirms, we perform the deletion.
    if (strpos($callback_data, 'admin_delete_category_confirm_') === 0) {
        global $conn;
        $cat_id = (int) str_replace('admin_delete_category_confirm_', '', $callback_data);

        // Final safety check just in case
        $products_in_cat = query("SELECT", "products", false, [["key" => "category_id", "condition" => "=", "value" => $cat_id]]);
        if ($products_in_cat) {
            sendMessage($chat_id, "🚫 خطا! این دسته‌بندی شامل محصول است و قابل حذف نیست.", false, $mesasge_id);
            exit;
        }

        // Perform the deletion
        $stmt = $conn->prepare("DELETE FROM categories WHERE id = :id");
        $stmt->execute([':id' => $cat_id]);

        sendMessage($chat_id, "✅ دسته‌بندی با موفقیت حذف شد.", false, $mesasge_id);

        // Show the updated list of categories to delete
        sendAdminCategoryListToDelete($chat_id, $mesasge_id);
        exit;
    }

    // --- END: Category Deletion Process ---


    // شروع افزودن دسته
    if ($callback_data === 'admin_add_category') {
        $stmt = $conn->prepare("DELETE FROM admin_process_state WHERE admin_user_id = :cid");
        $stmt->execute([':cid' => $chat_id]);

        query("CREATE", "admin_process_state", [
            "admin_user_id" => $chat_id,
            "process_name" => "add_category",
            "step" => 1
        ]);
        sendMessage($chat_id, "<b>مرحله ۱: افزودن دسته‌بندی</b>\n\nنام دسته‌بندی را وارد کنید:\n(برای لغو /cancel)");
        log_tg("CB_HANDLED: start add_category");
        exit;
    }

    // شروع افزودن محصول
    if ($callback_data === 'admin_add_product') {
        $stmt = $conn->prepare("DELETE FROM admin_process_state WHERE admin_user_id = :cid");
        $stmt->execute([':cid' => $chat_id]);

        query("CREATE", "admin_process_state", [
            "admin_user_id" => $chat_id,
            "process_name" => "add_product",
            "step" => 1
        ]);
        sendMessage($chat_id, "<b>مرحله ۱: افزودن محصول</b>\n\nنام محصول را وارد کنید:\n(برای لغو /cancel)");
        log_tg("CB_HANDLED: start add_product");
        exit;
    }

    // لیست ویرایش/حذف قدیمی (حذف را همان قبلی می‌گذاریم)
    if ($callback_data === 'admin_delete_product') {
        sendAdminProductList($chat_id, 'delete_product', $mesasge_id);
        log_tg("CB_HANDLED: list delete_product");
        exit;
    }

    if ($callback_data === 'admin_delete_cattegory') {
        sendAdminProductList($chat_id, 'delete_cattegory', $mesasge_id);
        log_tg("CB_HANDLED: list delete_product");
        exit;
    }




    // لیست جدید: «همه‌ی محصولات»
    if ($callback_data === 'admin_edit_product_all') {
        listAllProductsForEdit($chat_id, $mesasge_id);
        exit;
    }

    // نمایش محصول برای ویرایش (سازگار با قدیمی)
    if (strpos($callback_data, 'admin_edit_select_') === 0) {
        $pid = (int) str_replace('admin_edit_select_', '', $callback_data);
        showProductInfo($chat_id, $pid, 'view', $mesasge_id);
        log_tg("CB_HANDLED: showProductInfo view pid={$pid}");
        exit;
    }

    // نمایش محصول برای حذف (تایید)
    if (strpos($callback_data, 'admin_delete_select_') === 0) {
        $pid = (int) str_replace('admin_delete_select_', '', $callback_data);
        showProductInfo($chat_id, $pid, 'delete', $mesasge_id);
        log_tg("CB_HANDLED: showProductInfo delete pid={$pid}");
        exit;
    }

    // حذف نرم
    if (strpos($callback_data, 'admin_delete_confirm_') === 0) {
        $pid = (int) str_replace('admin_delete_confirm_', '', $callback_data);
        query("UPDATE", "products", ["status" => "disable"], [
            ["key" => "id", "condition" => "=", "value" => $pid]
        ]);
        sendMessage($chat_id, "✅ محصول <b>#{$pid}</b> غیرفعال شد.", build_back_to_admin_panel_inline(), $mesasge_id);
        log_tg("CB_HANDLED: delete_confirm pid={$pid}");
        exit;
    }

    /* =================== EDIT MENU =================== */
    if (strpos($callback_data, 'admin_edit_menu_') === 0) {
        $pid = (int) str_replace('admin_edit_menu_', '', $callback_data);

        $option = [
            [
                $telegram->buildInlineKeyBoardButton("📝 تغییر نام", '', 'admin_edit_field_title_' . $pid),
                $telegram->buildInlineKeyBoardButton("💬 تغییر توضیحات", '', 'admin_edit_field_description_' . $pid)
            ],
            [
                $telegram->buildInlineKeyBoardButton("💵 تغییر قیمت", '', 'admin_edit_field_price_' . $pid),
                $telegram->buildInlineKeyBoardButton("✍️ تغییر نویسنده", '', 'admin_edit_field_author_' . $pid)
            ],
            [
                $telegram->buildInlineKeyBoardButton("🖼 تغییر تصویر", '', 'admin_edit_field_image_' . $pid),
                $telegram->buildInlineKeyBoardButton("📦 تغییر موجودی", '', 'admin_edit_field_inventory_' . $pid)
            ],
            [
                $telegram->buildInlineKeyBoardButton("🔁 تغییر دسته", '', 'admin_edit_change_cat_' . $pid),
                $telegram->buildInlineKeyBoardButton("⏯ تغییر وضعیت", '', 'admin_edit_toggle_status_' . $pid)
            ],
            [$telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_edit_product_all')],
        ];
        $keyb = $telegram->buildInlineKeyBoard($option);
        sendMessage($chat_id, "یک گزینه برای ویرایش محصول #{$pid} انتخاب کنید:", $keyb, $mesasge_id);
        log_tg("CB_HANDLED: open edit menu pid={$pid}");
        exit;
    }

    // شروع ویرایش فیلدها (state: edit_product / step: نام فیلد)
    $edit_fields = ['title', 'description', 'price', 'author', 'image', 'inventory'];
    foreach ($edit_fields as $f) {
        $prefix = 'admin_edit_field_' . $f . '_';
        if (strpos($callback_data, $prefix) === 0) {
            $pid = (int) str_replace($prefix, '', $callback_data);

            $stmt = $conn->prepare("DELETE FROM admin_process_state WHERE admin_user_id = :cid AND process_name='edit_product'");
            $stmt->execute([':cid' => $chat_id]);

            query("CREATE", "admin_process_state", [
                "admin_user_id" => $chat_id,
                "process_name" => "edit_product",
                "step" => $f,
                "step_data" => json_encode(["product_id" => $pid], JSON_UNESCAPED_UNICODE)
            ]);

            $prompts = [
                'title' => "نام جدید محصول را بفرستید:",
                'description' => "توضیحات جدید محصول را بفرستید:",
                'price' => "قیمت جدید را به تومان (فقط عدد) بفرستید:",
                'author' => "نام نویسنده/مدرس جدید را بفرستید:",
                'image' => "URL تصویر جدید را بفرستید:",
                'inventory' => "موجودی جدید را (فقط عدد) بفرستید:",
            ];
            sendMessage($chat_id, "✏️ ویرایش <b>{$f}</b> برای محصول #{$pid}\n\n" . $prompts[$f] . "\n(برای لغو /cancel)");
            log_tg("CB_HANDLED: start edit field={$f} pid={$pid}");
            exit;
        }
    }

    // تغییر دسته: نمایش لیست
    if (strpos($callback_data, 'admin_edit_change_cat_') === 0) {
        $pid = (int) str_replace('admin_edit_change_cat_', '', $callback_data);

        $categories = query("SELECT", "categories", false, [["key" => "status", "condition" => "=", "value" => "enable"]], true);
        if (!$categories || count($categories) === 0) {
            sendMessage($chat_id, "❌ هیچ دسته فعالی وجود ندارد.", build_back_to_admin_panel_inline());
            log_tg("CB_ERR: no categories to change pid={$pid}");
            exit;
        }
        $option = [];
        foreach ($categories as $cat) {
            $label = (($cat->icon ?? '') ?: '📂') . ' ' . $cat->name;
            $option[] = [$telegram->buildInlineKeyBoardButton($label, '', 'admin_edit_set_cat_' . $pid . '_' . (int) $cat->id)];
        }
        $option[] = [$telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_edit_menu_' . $pid)];
        $keyb = $telegram->buildInlineKeyBoard($option);
        sendMessage($chat_id, "🔁 دسته‌ی جدید را برای محصول #{$pid} انتخاب کنید:", $keyb);
        log_tg("CB_HANDLED: change_cat menu pid={$pid}");
        exit;
    }

    // ست‌کردن دسته جدید
    if (strpos($callback_data, 'admin_edit_set_cat_') === 0) {
        $parts = explode('_', $callback_data);
        $pid = (int) ($parts[4] ?? 0);
        $catid = (int) ($parts[5] ?? 0);

        if ($pid > 0 && $catid > 0) {
            query("UPDATE", "products", ["category_id" => $catid], [["key" => "id", "condition" => "=", "value" => $pid]]);
            sendMessage($chat_id, "✅ دسته‌ی محصول #{$pid} تغییر کرد به {$catid}.", build_back_to_admin_panel_inline());
            showProductInfo($chat_id, $pid, 'view', $mesasge_id);
            log_tg("CB_HANDLED: set_cat pid={$pid} cat={$catid}");
            exit;
        }
        sendMessage($chat_id, "❌ داده‌ی نامعتبر برای تغییر دسته.", build_back_to_admin_panel_inline());
        log_tg("CB_ERR: set_cat invalid data");
        exit;
    }

    // تغییر وضعیت enable/disable (محصول)
    if (strpos($callback_data, 'admin_edit_toggle_status_') === 0) {
        $pid = (int) str_replace('admin_edit_toggle_status_', '', $callback_data);
        $p = query("SELECT", "products", false, [["key" => "id", "condition" => "=", "value" => $pid]]);
        if (!$p) {
            sendMessage($chat_id, "❌ محصول یافت نشد.", build_back_to_admin_panel_inline());
            log_tg("CB_ERR: toggle_status product not found pid={$pid}");
            exit;
        }
        $new_status = ($p->status === 'enable') ? 'disable' : 'enable';
        query("UPDATE", "products", ["status" => $new_status], [["key" => "id", "condition" => "=", "value" => $pid]]);
        sendMessage($chat_id, "✅ وضعیت محصول #{$pid} به <b>{$new_status}</b> تغییر کرد.", build_back_to_admin_panel_inline());
        showProductInfo($chat_id, $pid, 'view', $mesasge_id);
        log_tg("CB_HANDLED: toggle_status pid={$pid} -> {$new_status}");
        exit;
    }

    // مرحله ۶: انتخاب دسته هنگام افزودن محصول
    if (strpos($callback_data, 'admin_p_select_cat_') === 0) {
        $category_id = (int) str_replace('admin_p_select_cat_', '', $callback_data);
        log_tg("STEP6_BEGIN: cat={$category_id}");

        try {
            $admin_state = query("SELECT", "admin_process_state", false, [
                ["key" => "admin_user_id", "condition" => "=", "value" => $chat_id],
                ["key" => "process_name", "condition" => "=", "value" => "add_product"]
            ], false, "id DESC");

            if (!$admin_state) {
                log_tg("STEP6_ERR: no admin_state for chat={$chat_id}");
                sendMessage($chat_id, "❌ فرایند افزودن محصول یافت نشد. دوباره شروع کنید.", build_back_to_admin_panel_inline());
                exit;
            }

            $step_data = json_decode($admin_state->step_data ?? "{}", true) ?: [];
            $title = trim($step_data['title'] ?? '');
            $desc = trim($step_data['description'] ?? '');
            $price = (int) ($step_data['price'] ?? 0);
            $author = trim($step_data['author'] ?? '');
            $image = trim($step_data['image_url'] ?? '');
            $inventory = isset($step_data['inventory']) ? (int) $step_data['inventory'] : 0;

            $new_id = query("CREATE", "products", [
                'title' => $title,
                'description' => $desc,
                'price' => $price,
                'author' => $author,
                'image_url' => $image,
                'category_id' => $category_id,
                'inventory' => $inventory,
                'status' => 'enable'
            ]);

            $stmt = $conn->prepare("DELETE FROM admin_process_state WHERE id = :id");
            $stmt->execute([':id' => $admin_state->id]);

            sendMessage($chat_id, "✅ محصول '<b>" . htmlspecialchars($title, ENT_QUOTES, 'UTF-8') . "</b>' اضافه شد.", build_back_to_admin_panel_inline());
            log_tg("STEP6_CREATED: product_id={$new_id}");
            exit;

        } catch (\Throwable $e) {
            log_tg("STEP6_EXCEPTION: " . $e->getMessage());
            sendMessage($chat_id, "❌ خطا هنگام ثبت محصول. لطفاً دوباره تلاش کنید یا /cancel بزنید.", build_back_to_admin_panel_inline());
            exit;
        }
    }

    /* =================== مدیریت دسته‌بندی‌ها =================== */
    if ($callback_data === 'admin_manage_categories') {
        listCategoriesManage($chat_id, $mesasge_id);
        exit;
    }
    if (strpos($callback_data, 'admin_toggle_category_') === 0) {
        $cid = (int) str_replace('admin_toggle_category_', '', $callback_data);
        $cat = query("SELECT", "categories", false, [["key" => "id", "condition" => "=", "value" => $cid]]);
        if (!$cat) {
            sendMessage($chat_id, "❌ دسته‌بندی یافت نشد.", build_back_to_admin_panel_inline());
            exit;
        }
        $new = ($cat->status === 'enable' ? 'disable' : 'enable');
        query("UPDATE", "categories", ["status" => $new], [["key" => "id", "condition" => "=", "value" => $cid]]);
        sendMessage($chat_id, "✅ وضعیت دسته «{$cat->name}» به <b>{$new}</b> تغییر کرد.");
        listCategoriesManage($chat_id);
        exit;
    }

    /* =================== سفارشات پرداخت‌شده + تایید/رد =================== */
    if ($callback_data === 'admin_orders_paid') {
        listPaidOrders($chat_id, $mesasge_id);
        exit;
    }
    if (strpos($callback_data, 'admin_order_view_') === 0) {
        $oid = (int) str_replace('admin_order_view_', '', $callback_data);
        showOrderDetailsToAdmin($chat_id, $oid, $mesasge_id);
        exit;
    }
    if (strpos($callback_data, 'admin_order_approve_') === 0) {
        $oid = (int) str_replace('admin_order_approve_', '', $callback_data);

        // --- شروع بخش جدید: کاهش موجودی ---
        $order_items = query("SELECT", "orders_item", false, [["key"=>"order_id","condition"=>"=","value"=>$oid]], true);
        
        // چک کردن موجودی قبل از تایید نهایی
        foreach ($order_items as $item) {
            $product = query("SELECT", "products", false, [["key"=>"id","condition"=>"=","value"=>$item->product_id]]);
            if (!$product || $product->inventory < $item->quantity) {
                $error_msg = "⚠️ <b>خطا در تایید سفارش #{$oid}</b>\n\n";
                $error_msg .= "موجودی محصول '<b>" . ($product->title ?? 'ناشناخته') . "</b>' کافی نیست.\n";
                $error_msg .= "موجودی فعلی: " . ($product->inventory ?? 0) . " | تعداد درخواستی: " . $item->quantity;
                sendMessage($chat_id, $error_msg);
                exit; // عملیات را متوقف کن
            }
        }

        // اگر موجودی کافی بود، آن را کاهش بده
        foreach ($order_items as $item) {
            $conn->prepare("UPDATE products SET inventory = inventory - :qty WHERE id = :pid")
                 ->execute([':qty' => $item->quantity, ':pid' => $item->product_id]);
        }
        // --- پایان بخش جدید ---

        query("UPDATE", "orders", ["status" => "approved"], [["key" => "id", "condition" => "=", "value" => $oid]]);
        sendMessage($chat_id, "✅ سفارش #{$oid} تایید شد.");
        showOrderDetailsToAdmin($chat_id, $oid);
        exit;
    }
    if (strpos($callback_data, 'admin_order_reject_') === 0) {
        $oid = (int) str_replace('admin_order_reject_', '', $callback_data);
        query("UPDATE", "orders", ["status" => "rejected"], [["key" => "id", "condition" => "=", "value" => $oid]]);
        sendMessage($chat_id, "❌ سفارش #{$oid} رد شد.");
        showOrderDetailsToAdmin($chat_id, $oid);
        exit;
    }

    if (strpos($callback_data, 'admin_order_send_') === 0) {
        $oid = (int) str_replace('admin_order_send_', '', $callback_data);
        query("UPDATE", "orders", ["status" => "sending"], [["key" => "id", "condition" => "=", "value" => $oid]]);
        sendMessage($chat_id, "🚌 سفارش #{$oid} به خریدار ارسال شد.");
        showOrderDetailsToAdmin($chat_id, $oid);
        exit;
    }


    /* =================== گفتگو ادمین با خریدار =================== */
    // شروع گفتگو با خریدار: admin_contact_buyer_{order_id}
    if (strpos($callback_data, 'admin_contact_buyer_') === 0) {
        $oid = (int) str_replace('admin_contact_buyer_', '', $callback_data);

        $order = query("SELECT", "orders", false, [["key" => "id", "condition" => "=", "value" => $oid]]);
        if (!$order) {
            sendMessage($chat_id, "❌ سفارش یافت نشد.");
            log_tg("CB_ERR: contact_buyer order not found oid={$oid}");
            exit;
        }

        // گرفتن chat_id خریدار
        $buyer_chat_id = (int) ($order->user_chat_id ?? 0);
        if ($buyer_chat_id <= 0 && !empty($order->user_id)) {
            $u = query("SELECT", "users", false, [["key" => "id", "condition" => "=", "value" => $order->user_id]]);
            $buyer_chat_id = (int) ($u->chat_id ?? 0);
        }
        if ($buyer_chat_id <= 0) {
            sendMessage($chat_id, "⚠️ chat_id مشتری در سفارش ذخیره نشده است.");
            log_tg("CB_ERR: contact_buyer no chat_id oid={$oid}");
            exit;
        }

        // پاک‌سازی state قبلی
        $stmt = $conn->prepare("DELETE FROM admin_process_state WHERE (admin_user_id=:a AND process_name='admin_msg_buyer') OR (admin_user_id=:b AND process_name='buyer_reply')");
        $stmt->execute([':a' => $chat_id, ':b' => $buyer_chat_id]);

        // ساخت state برای ادمین (ارسال پیام)
        query("CREATE", "admin_process_state", [
            "admin_user_id" => $chat_id,
            "process_name" => "admin_msg_buyer",
            "step" => "await",
            "step_data" => json_encode([
                "order_id" => $oid,
                "buyer_chat_id" => $buyer_chat_id
            ], JSON_UNESCAPED_UNICODE)
        ]);

        // ساخت state برای خریدار (پاسخ)
        query("CREATE", "admin_process_state", [
            "admin_user_id" => $buyer_chat_id,
            "process_name" => "buyer_reply",
            "step" => "await",
            "step_data" => json_encode([
                "order_id" => $oid,
                "admin_chat_id" => $chat_id
            ], JSON_UNESCAPED_UNICODE)
        ]);

        // راهنمای ادمین
        $kb = $telegram->buildInlineKeyBoard([
            [$telegram->buildInlineKeyBoardButton("🔚 پایان گفتگو", '', 'admin_close_dialog_' . $buyer_chat_id)],
            [$telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_root')],
        ]);
        sendMessage($chat_id, "✍️ پیام‌تان را برای خریدار بفرستید.\nمی‌توانید <b>متن</b> یا <b>عکس با کپشن</b> ارسال کنید.\n(برای لغو /cancel)", $kb);
        log_tg("CB_HANDLED: contact_buyer oid={$oid} buyer={$buyer_chat_id}");
        exit;
    }

    // بستن گفتگو: admin_close_dialog_{buyer_chat_id}
    if (strpos($callback_data, 'admin_close_dialog_') === 0) {
        $bchat = (int) str_replace('admin_close_dialog_', '', $callback_data);
        $stmt = $conn->prepare("DELETE FROM admin_process_state WHERE (admin_user_id=:a AND process_name='admin_msg_buyer') OR (admin_user_id=:b AND process_name='buyer_reply')");
        $stmt->execute([':a' => $chat_id, ':b' => $bchat]);
        sendMessage($chat_id, "🔒 گفتگو بسته شد.", build_back_to_admin_panel_inline());
        log_tg("CB_HANDLED: close_dialog buyer={$bchat}");
        exit;
    }

    // لغو عملیات (جنرال)
    if ($callback_data === 'admin_cancel_process') {
        $stmt = $conn->prepare("DELETE FROM admin_process_state WHERE admin_user_id = :cid");
        $stmt->execute([':cid' => $chat_id]);
        sendMessage($chat_id, "✅ عملیات لغو شد.", build_back_to_admin_panel_inline());
        log_tg("CB_HANDLED: admin_cancel_process");
        exit;
    }

    // سایر
    sendMessage($chat_id, "این بخش در حال توسعه است.", build_back_to_admin_panel_inline(), $mesasge_id);
    log_tg("CB_FALLBACK: {$callback_data}");
    exit;
}

/* ======================================================================
   پردازش پیام (متنی/عکس)
   ====================================================================== */
if ($text_message || !empty($update['message'])) {
    if ($text_message) {
        log_tg("MSG_RECEIVED: chat={$chat_id} text=" . mb_substr($text_message, 0, 64));
    } else {
        log_tg("MSG_RECEIVED: chat={$chat_id} type=" . implode(',', array_keys($update['message'])));
    }

    if ($text_message === '/cancel') {
        $stmt = $conn->prepare("DELETE FROM admin_process_state WHERE admin_user_id = :cid");
        $stmt->execute([':cid' => $chat_id]);
        sendMessage($chat_id, "✅ عملیات لغو شد.", build_back_to_admin_panel_inline());
        log_tg("MSG_HANDLED: cancel");
        exit;
    }

    if ($text_message === '/admin' || $text_message === '/start') {
        sendAdminRootMenu($chat_id, $mesasge_id);
        // کیبورد همیشگی /admin را هم بفرستیم (یک‌بار هر بار)
//        send_quick_admin_reply_keyboard($chat_id);
        exit;
    }




    // لود state برای chat_id فعلی
    $admin_state = query(
        "SELECT",
        "admin_process_state",
        false,
        [
            ["key" => "admin_user_id", "condition" => "=", "value" => $chat_id]
        ],
        false,
        "id DESC"
    );
    if (!$admin_state) {
        log_tg("MSG_INFO: no active state");
        exit;
    }

    if ($admin_state->process_name === 'edit_setting') {
        global $conn;
        
        $step_data = json_decode($admin_state->step_data, true);
        $setting_key = $step_data['key'];
        $setting_value = $text_message;

        // Use INSERT ... ON DUPLICATE KEY UPDATE for efficiency
        $sql = "INSERT INTO settings (setting_key, setting_value) VALUES (:skey, :sval)
                ON DUPLICATE KEY UPDATE setting_value = :sval";
        $stmt = $conn->prepare($sql);
        $stmt->execute([':skey' => $setting_key, ':sval' => $setting_value]);

        // Clear the process state
        $conn->prepare("DELETE FROM admin_process_state WHERE id = :id")->execute([':id' => $admin_state->id]);

        sendMessage($chat_id, "✅ تنظیمات با موفقیت به‌روزرسانی شد.");
        sendAdminSettingsMenu($chat_id);
        exit;
    }

    $process_name = $admin_state->process_name;
    $step = (string) $admin_state->step;
    $step_data = json_decode($admin_state->step_data ?? "{}", true) ?: [];



    /* ----------------- افزودن سوال متداول ----------------- */
    if ($process_name === 'add_faq') {
        if ($step === '1') { // دریافت سوال
            $step_data['question'] = $text_message;
            query("UPDATE", "admin_process_state",
                ["step" => 2, "step_data" => json_encode($step_data, JSON_UNESCAPED_UNICODE)],
                [["key"=>"id","condition"=>"=","value"=>$admin_state->id]]
            );
            sendMessage($chat_id, "<b>مرحله ۲:</b>\n\nحالا «پاسخ» این سوال را وارد کنید:\n(برای لغو /cancel)");
            exit;
        } elseif ($step === '2') { // دریافت پاسخ و ذخیره
            $step_data['answer'] = $text_message;
            query("CREATE", "faqs", [
                "question" => $step_data['question'],
                "answer"   => $step_data['answer'],
                "status" => "enable"
            ]);
            $conn->prepare("DELETE FROM admin_process_state WHERE id = :id")->execute([':id' => $admin_state->id]);
            sendMessage($chat_id, "✅ سوال جدید با موفقیت اضافه شد.", build_back_to_admin_panel_inline());
            exit;
        }
    }


    /* ----------------- افزودن دسته ----------------- */
    if ($process_name === 'add_category') {
        if ($step === '1') {
            $step_data['name'] = $text_message;
            query(
                "UPDATE",
                "admin_process_state",
                ["step" => 2, "step_data" => json_encode($step_data, JSON_UNESCAPED_UNICODE)],
                [["key" => "id", "condition" => "=", "value" => $admin_state->id]]
            );
            sendMessage($chat_id, "<b>مرحله ۲:</b>\n\nیک آیکون (ایموجی) برای دسته‌بندی بفرستید (مثال: ✨)\n(برای لغو /cancel)");
            log_tg("STATE: add_category -> step 2");
            exit;
        } elseif ($step === '2') {
            $step_data['icon'] = $text_message;
            query("CREATE", "categories", [
                "name" => $step_data['name'],
                "icon" => $step_data['icon'],
                "status" => "enable"
            ]);
            $conn->prepare("DELETE FROM admin_process_state WHERE id = :id")->execute([':id' => $admin_state->id]);
            sendMessage($chat_id, "✅ دسته‌بندی '<b>{$step_data['name']}</b>' اضافه شد.", build_back_to_admin_panel_inline());
            log_tg("STATE_DONE: add_category name={$step_data['name']}");
            exit;
        }
    }

    /* ----------------- افزودن محصول ----------------- */
    if ($process_name === 'add_product') {
        if ($step === '1') {
            $step_data['title'] = $text_message;
            query("UPDATE", "admin_process_state",
                ["step" => 2, "step_data" => json_encode($step_data, JSON_UNESCAPED_UNICODE)],
                [["key"=>"id","condition"=>"=","value"=>$admin_state->id]]
            );
            sendMessage($chat_id, "<b>مرحله ۲:</b>\n\nتوضیحات محصول را وارد کنید:\n(برای لغو /cancel)");
            log_tg("STATE: add_product -> step 2");
            exit;
        } elseif ($step === '2') {
            $step_data['description'] = $text_message;
            query("UPDATE", "admin_process_state",
                ["step" => 3, "step_data" => json_encode($step_data, JSON_UNESCAPED_UNICODE)],
                [["key"=>"id","condition"=>"=","value"=>$admin_state->id]]
            );
            sendMessage($chat_id, "<b>مرحله ۳:</b>\n\nقیمت محصول را به تومان (فقط عدد) وارد کنید:\n(برای لغو /cancel)");
            log_tg("STATE: add_product -> step 3");
            exit;
        } elseif ($step === '3') {
            if (!is_numeric($text_message)) {
                sendMessage($chat_id, "❌ لطفاً قیمت را فقط به صورت عدد وارد کنید.", build_back_to_admin_panel_inline());
                log_tg("STATE_ERR: price not numeric");
                exit;
            }
            $step_data['price'] = (int)$text_message;
            query("UPDATE", "admin_process_state",
                ["step" => 4, "step_data" => json_encode($step_data, JSON_UNESCAPED_UNICODE)],
                [["key"=>"id","condition"=>"=","value"=>$admin_state->id]]
            );
            sendMessage($chat_id, "<b>مرحله ۴:</b>\n\nنام نویسنده/مدرس را وارد کنید:\n(برای لغو /cancel)");
            log_tg("STATE: add_product -> step 4");
            exit;
        } elseif ($step === '4') {
            $step_data['author'] = $text_message;
            query("UPDATE", "admin_process_state",
                ["step" => 5, "step_data" => json_encode($step_data, JSON_UNESCAPED_UNICODE)],
                [["key"=>"id","condition"=>"=","value"=>$admin_state->id]]
            );
            sendMessage($chat_id, "<b>مرحله ۵:</b>\n\nتعداد موجودی محصول را وارد کنید (فقط عدد):\n(برای لغو /cancel)");
            log_tg("STATE: add_product -> step 5");
            exit;
        } elseif ($step === '5') {
            if (!is_numeric($text_message)) {
                sendMessage($chat_id, "❌ لطفاً موجودی را فقط به صورت عدد وارد کنید.", build_back_to_admin_panel_inline());
                log_tg("STATE_ERR: inventory not numeric");
                exit;
            }
            $step_data['inventory'] = (int)$text_message;
            query("UPDATE", "admin_process_state",
                ["step" => 6, "step_data" => json_encode($step_data, JSON_UNESCAPED_UNICODE)],
                [["key"=>"id","condition"=>"=","value"=>$admin_state->id]]
            );
            sendMessage($chat_id, "<b>مرحله ۶:</b>\n\nتصویر محصول را ارسال کنید (به صورت Photo):\n(می‌توانید یک URL هم بفرستید)");
            log_tg("STATE: add_product -> step 6");
            exit;
        } elseif ($step === '6') {

            global $BASE_PUBLIC_URL;
            $image_url = null;
            $file_id = extractImageFileIdFromMessage($resultTelegram); // $resultTelegram از index.php میاد

            if ($file_id) { // اگر کاربر عکس فرستاد
                if (empty($BASE_PUBLIC_URL)) {
                    sendMessage($chat_id, "❌ خطا: آدرس پایه URL در تنظیمات ست نشده. امکان آپلود فایل وجود ندارد.");
                    exit;
                }
                list($ok, $pathOrErr) = downloadTelegramFileById($file_id, 'uploads/products');
                if (!$ok) {
                    sendMessage($chat_id, "⚠️ خطا در آپلود تصویر: ".$pathOrErr."\nلطفاً دوباره تلاش کنید.");
                    exit;
                }
                $image_url = rtrim($BASE_PUBLIC_URL, '/') . '/' . $pathOrErr;
            } elseif (!empty($text_message) && filter_var($text_message, FILTER_VALIDATE_URL)) { // اگر کاربر لینک فرستاد
                $image_url = $text_message;
            } else {
                sendMessage($chat_id, "❌ ورودی نامعتبر است. لطفاً یک تصویر یا یک URL صحیح ارسال کنید.");
                exit;
            }

            $step_data['image_url'] = $image_url;
            // --- پایان بخش جدید ---

            query("UPDATE", "admin_process_state",
                ["step" => 7, "step_data" => json_encode($step_data, JSON_UNESCAPED_UNICODE)],
                [["key"=>"id","condition"=>"=","value"=>$admin_state->id]]
            );

            $categories = query("SELECT", "categories", false, [
                ["key" => "status", "condition" => "=", "value" => "enable"]
            ], true);

            if (!$categories || count($categories) === 0) {
                $conn->prepare("DELETE FROM admin_process_state WHERE id = :id")->execute([':id' => $admin_state->id]);
                sendMessage($chat_id, "❌ هیچ دسته‌بندی فعالی وجود ندارد. ابتدا یک دسته‌بندی ایجاد کنید.", build_back_to_admin_panel_inline());
                log_tg("STATE_ERR: no categories to pick");
                exit;
            }

            $option = [];
            foreach ($categories as $cat) {
                $label = (($cat->icon ?? '') ?: '📂') . ' ' . $cat->name;
                $option[] = [$telegram->buildInlineKeyBoardButton($label, '', 'admin_p_select_cat_' . (int)$cat->id)];
            }
            $option[] = [$telegram->buildInlineKeyBoardButton("لغو عملیات ❌", '', 'admin_cancel_process')];

            $keyb = $telegram->buildInlineKeyBoard($option);
            sendMessage($chat_id, "<b>مرحله نهایی (۷):</b>\n\nدسته‌بندی این محصول را انتخاب کنید:", $keyb);
            log_tg("STATE: add_product -> step 7 (await category)");
            exit;
        }
    }


    /* ----------------- ویرایش محصول (text) ----------------- */
    if ($process_name === 'edit_product') {
        $field = (string) $step; // نام فیلد (رشته)
        $pid = (int) ($step_data['product_id'] ?? 0);

        if ($pid <= 0) {
            sendMessage($chat_id, "❌ محصول نامعتبر.", build_back_to_admin_panel_inline());
            log_tg("EDIT_ERR: invalid pid in state");
            exit;
        }

        // این متغیر مقدار نهایی برای ذخیره در دیتابیس خواهد بود
        $final_value = null;

        // --- مدیریت ویژه فیلد تصویر ---
        if ($field === 'image') {
            global $BASE_PUBLIC_URL;
            $file_id = extractImageFileIdFromMessage($resultTelegram);

            if ($file_id) { // اگر عکس فرستاده شد
                if (empty($BASE_PUBLIC_URL)) {
                    sendMessage($chat_id, "❌ خطا: آدرس پایه URL در تنظیمات ست نشده.");
                    exit;
                }
                list($ok, $pathOrErr) = downloadTelegramFileById($file_id, 'uploads/products');
                if (!$ok) {
                    sendMessage($chat_id, "⚠️ خطا در آپلود تصویر: " . $pathOrErr);
                    exit;
                }
                $final_value = rtrim($BASE_PUBLIC_URL, '/') . '/' . $pathOrErr;

            } elseif (!empty($text_message) && filter_var($text_message, FILTER_VALIDATE_URL)) { // اگر لینک فرستاده شد
                $final_value = $text_message;
            } else {
                sendMessage($chat_id, "❌ لطفاً یک تصویر معتبر یا یک URL صحیح ارسال کنید.");
                exit;
            }
        } else { // برای سایر فیلدها مثل قبل عمل کن
            $final_value = isset($text_message) ? trim($text_message) : null;
            if ($field === 'price' || $field === 'inventory') {
                if (!is_numeric($final_value)) {
                    sendMessage($chat_id, "❌ لطفاً مقدار عددی معتبر وارد کنید.", build_back_to_admin_panel_inline());
                    exit;
                }
                $final_value = (int) $final_value;
            }
        }

        $map = [
            'title'       => 'title',
            'description' => 'description',
            'price'       => 'price',
            'author'      => 'author',
            'image'       => 'image_url',
            'inventory'   => 'inventory',
        ];

        if (!isset($map[$field])) {
            sendMessage($chat_id, "❌ فیلد ناشناخته برای ویرایش.", build_back_to_admin_panel_inline());
            log_tg("EDIT_ERR: unknown field={$field}");
            exit;
        }

        // *** اصلاح اصلی اینجاست: استفاده از final_value$ به جای value$ ***
        query("UPDATE", "products", [$map[$field] => $final_value], [["key" => "id", "condition" => "=", "value" => $pid]]);

        $conn->prepare("DELETE FROM admin_process_state WHERE id = :id")->execute([':id' => $admin_state->id]);
        sendMessage($chat_id, "✅ مقدار <b>{$field}</b> محصول #{$pid} بروزرسانی شد.", build_back_to_admin_panel_inline());
        showProductInfo($chat_id, $pid, 'view', $mesasge_id);
        
        // *** اصلاح دوم: استفاده از final_value$ برای لاگ ***
        log_tg("EDIT_DONE: field={$field} pid={$pid} value=" . mb_substr((string) $final_value, 0, 60));
        exit;
    }

    /* ----------------- گفتگو ادمین با خریدار ----------------- */
    if ($process_name === 'admin_msg_buyer') {
        $buyer_chat_id = (int) ($step_data['buyer_chat_id'] ?? 0);
        $order_id = (int) ($step_data['order_id'] ?? 0);

        if ($buyer_chat_id <= 0) {
            sendMessage($chat_id, "❌ گیرنده معتبر نیست.", build_back_to_admin_panel_inline());
            log_tg("DIALOG_ERR: admin_msg_buyer no buyer_chat_id");
            exit;
        }

        $photo_id = extract_photo_from_update($update);
        $caption = extract_caption_from_update($update);

        if ($photo_id) {
            $telegram->sendPhoto([
                'chat_id' => $buyer_chat_id,
                'photo' => $photo_id,
                'caption' => $caption ? "📣 پیام پشتیبانی:\n" . $caption : "📣 پیام پشتیبانی",
                'parse_mode' => 'HTML'
            ]);
        } elseif (!empty($text_message)) {
            sendMessage(
                $buyer_chat_id,
                "📣 <b>پیام از پشتیبانی:</b>\n\n" . $text_message
            );
        } else {
            sendMessage($chat_id, "⚠️ فقط متن یا عکس را بفرستید.", build_back_to_admin_panel_inline());
            log_tg("DIALOG_WARN: admin_msg_buyer unknown payload");
            exit;
        }

        $kb = $telegram->buildInlineKeyBoard([
            [$telegram->buildInlineKeyBoardButton("🔚 پایان گفتگو", '', 'admin_close_dialog_' . $buyer_chat_id)],
            [$telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_root')],
        ]);
        sendMessage($chat_id, "✅ پیام برای خریدار ارسال شد.", $kb);
        log_tg("DIALOG_INFO: sent to buyer={$buyer_chat_id} by admin={$chat_id} order={$order_id}");
        exit;
    }

    if ($process_name === 'buyer_reply') {
        $admin_id = (int) ($step_data['admin_chat_id'] ?? 0);
        $order_id = (int) ($step_data['order_id'] ?? 0);

        if ($admin_id <= 0) {
            $conn->prepare("DELETE FROM admin_process_state WHERE id = :id")->execute([':id' => $admin_state->id]);
            log_tg("DIALOG_ERR: buyer_reply no admin_id");
            exit;
        }

        $photo_id = extract_photo_from_update($update);
        $caption = extract_caption_from_update($update);

        if ($photo_id) {
            $telegram->sendPhoto([
                'chat_id' => $admin_id,
                'photo' => $photo_id,
                'caption' => "📥 پاسخ خریدار (Order #{$order_id}):\n" . $caption,
                'parse_mode' => 'HTML'
            ]);
        } elseif (!empty($text_message)) {
            sendMessage($admin_id, "📥 <b>پاسخ خریدار</b> (Order #{$order_id}):\n\n" . $text_message);
        } else {
            log_tg("DIALOG_WARN: buyer_reply unknown payload");
        }

        log_tg("DIALOG_INFO: buyer={$chat_id} -> admin={$admin_id} order={$order_id}");
        exit;
    }

    // خارج از فرایند
    log_tg("MSG_INFO: fell through");
    exit;
}
