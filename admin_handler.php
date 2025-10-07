<?php
// admin_handler.php
global $conn, $telegram, $resultTelegram, $chat_id, $mesasge_id;

/* ------------------ Logger ساده ------------------ */
function log_tg($msg) {
    $line = '['.date('c')."] ".$msg."\n";
    @file_put_contents(__DIR__ . '/tg.log', $line, FILE_APPEND);
}

/* --- نرمال‌سازی آپدیت: chat_id/message_id و callback_data --- */
$update = $resultTelegram ?? [];

if (isset($update['callback_query'])) {
    $chat_id     = $update['callback_query']['message']['chat']['id'] ?? $chat_id;
    $mesasge_id  = $update['callback_query']['message']['message_id'] ?? $mesasge_id;
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

// بستن لودینگ کال‌بک (UX بهتر)
if (isset($update['callback_query']['id']) && is_object($telegram) && method_exists($telegram, 'answerCallbackQuery')) {
    try {
        $telegram->answerCallbackQuery([
            'callback_query_id' => $update['callback_query']['id'],
            'text' => '👌',
            'show_alert' => false
        ]);
    } catch (\Throwable $e) { /* ignore */ }
}

/* ======================================================================
   کمک‌تابع‌ها برای تشخیص نوع پیام (عکس/کپشن/voice/...) از $update
   ====================================================================== */
function extract_photo_from_update($update) {
    // بزرگ‌ترین سایز عکس را برمی‌گرداند
    if (!empty($update['message']['photo']) && is_array($update['message']['photo'])) {
        $photos = $update['message']['photo'];
        $largest = end($photos);
        return $largest['file_id'] ?? null;
    }
    return null;
}
function extract_caption_from_update($update) {
    return $update['message']['caption'] ?? null;
}

/* ======================================================================
   پردازش دکمه‌های شیشه‌ای (Callback Query)
   ====================================================================== */
if ($callback_data) {
    log_tg("CB_RECEIVED: chat={$chat_id} data={$callback_data}");

    // ناوبری اصلی
    if ($callback_data === 'admin_panel' || $callback_data === 'start') {
        if ($callback_data === 'start') sendMainKeyboardMenu($chat_id, $mesasge_id);
        else sendAdminPanelMenu($chat_id, $mesasge_id);
        log_tg("CB_HANDLED: open_menu {$callback_data}");
        exit;
    }

    // آمار
    if ($callback_data === 'admin_stats') {
        $users_count      = (int)$conn->query("SELECT count(*) FROM users")->fetchColumn();
        $products_count   = (int)$conn->query("SELECT count(*) FROM products")->fetchColumn();
        $completed_orders = (int)$conn->query("SELECT count(*) FROM orders WHERE status = 'payed'")->fetchColumn();

        $stats_text  = "📊 <b>آمار کلی ربات:</b>\n\n";
        $stats_text .= "👤 تعداد کل کاربران: <b>{$users_count}</b>\n";
        $stats_text .= "📦 تعداد کل محصولات: <b>{$products_count}</b>\n";
        $stats_text .= "✅ سفارشات تکمیل شده: <b>{$completed_orders}</b>\n";

        $keyb = $telegram->buildInlineKeyBoard([[ $telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_panel') ]]);
        sendMessage($chat_id, $stats_text, $keyb, $mesasge_id);
        log_tg("CB_HANDLED: admin_stats");
        exit;
    }

    // شروع افزودن دسته
    if ($callback_data === 'admin_add_category') {
        $stmt = $conn->prepare("DELETE FROM admin_process_state WHERE admin_user_id = :cid");
        $stmt->execute([':cid' => $chat_id]);

        query("CREATE", "admin_process_state", [
            "admin_user_id" => $chat_id,
            "process_name"  => "add_category",
            "step"          => 1
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
            "process_name"  => "add_product",
            "step"          => 1
        ]);
        sendMessage($chat_id, "<b>مرحله ۱: افزودن محصول</b>\n\nنام محصول را وارد کنید:\n(برای لغو /cancel)");
        log_tg("CB_HANDLED: start add_product");
        exit;
    }

    // لیست ویرایش/حذف
    if ($callback_data === 'admin_edit_product') {
        sendAdminProductList($chat_id, 'edit_product', $mesasge_id);
        log_tg("CB_HANDLED: list edit_product");
        exit;
    }
    if ($callback_data === 'admin_delete_product') {
        sendAdminProductList($chat_id, 'delete_product', $mesasge_id);
        log_tg("CB_HANDLED: list delete_product");
        exit;
    }

    // نمایش محصول برای ویرایش
    if (strpos($callback_data, 'admin_edit_select_') === 0) {
        $pid = (int)str_replace('admin_edit_select_', '', $callback_data);
        showProductInfo($chat_id, $pid, 'view', $mesasge_id);
        log_tg("CB_HANDLED: showProductInfo view pid={$pid}");
        exit;
    }

    // نمایش محصول برای حذف (تایید)
    if (strpos($callback_data, 'admin_delete_select_') === 0) {
        $pid = (int)str_replace('admin_delete_select_', '', $callback_data);
        showProductInfo($chat_id, $pid, 'delete', $mesasge_id);
        log_tg("CB_HANDLED: showProductInfo delete pid={$pid}");
        exit;
    }

    // حذف نرم
    if (strpos($callback_data, 'admin_delete_confirm_') === 0) {
        $pid = (int)str_replace('admin_delete_confirm_', '', $callback_data);
        query("UPDATE", "products", ["status" => "disable"], [
            ["key"=>"id","condition"=>"=","value"=>$pid]
        ]);
        $keyb = $telegram->buildInlineKeyBoard([[ $telegram->buildInlineKeyBoardButton("بازگشت به پنل 🔙", '', 'admin_panel') ]]);
        sendMessage($chat_id, "✅ محصول با شناسه <b>{$pid}</b> غیرفعال شد.", $keyb, $mesasge_id);
        log_tg("CB_HANDLED: delete_confirm pid={$pid}");
        exit;
    }

    /* =================== EDIT MENU =================== */
    if (strpos($callback_data, 'admin_edit_menu_') === 0) {
        $pid = (int)str_replace('admin_edit_menu_', '', $callback_data);

        $option = [
            [ $telegram->buildInlineKeyBoardButton("📝 تغییر نام", '', 'admin_edit_field_title_' . $pid),
              $telegram->buildInlineKeyBoardButton("💬 تغییر توضیحات", '', 'admin_edit_field_description_' . $pid) ],
            [ $telegram->buildInlineKeyBoardButton("💵 تغییر قیمت", '', 'admin_edit_field_price_' . $pid),
              $telegram->buildInlineKeyBoardButton("✍️ تغییر نویسنده", '', 'admin_edit_field_author_' . $pid) ],
            [ $telegram->buildInlineKeyBoardButton("🖼 تغییر تصویر", '', 'admin_edit_field_image_' . $pid),
              $telegram->buildInlineKeyBoardButton("📦 تغییر موجودی", '', 'admin_edit_field_inventory_' . $pid) ],
            [ $telegram->buildInlineKeyBoardButton("🔁 تغییر دسته", '', 'admin_edit_change_cat_' . $pid),
              $telegram->buildInlineKeyBoardButton("⏯ تغییر وضعیت", '', 'admin_edit_toggle_status_' . $pid) ],
            [ $telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_edit_select_' . $pid) ],
        ];
        $keyb = $telegram->buildInlineKeyBoard($option);
        sendMessage($chat_id, "یک گزینه برای ویرایش محصول #{$pid} انتخاب کنید:", $keyb, $mesasge_id);
        log_tg("CB_HANDLED: open edit menu pid={$pid}");
        exit;
    }

    // شروع ویرایش فیلدها (state: edit_product / step: نام فیلد)
    $edit_fields = ['title','description','price','author','image','inventory'];
    foreach ($edit_fields as $f) {
        $prefix = 'admin_edit_field_' . $f . '_';
        if (strpos($callback_data, $prefix) === 0) {
            $pid = (int)str_replace($prefix, '', $callback_data);

            $stmt = $conn->prepare("DELETE FROM admin_process_state WHERE admin_user_id = :cid AND process_name='edit_product'");
            $stmt->execute([':cid' => $chat_id]);

            query("CREATE", "admin_process_state", [
                "admin_user_id" => $chat_id,
                "process_name"  => "edit_product",
                "step"          => $f, // ← رشته است و با اسکیما فعلی شما سازگار است (VARCHAR(32))
                "step_data"     => json_encode(["product_id" => $pid], JSON_UNESCAPED_UNICODE)
            ]);

            $prompts = [
                'title'     => "نام جدید محصول را بفرستید:",
                'description'=> "توضیحات جدید محصول را بفرستید:",
                'price'     => "قیمت جدید را به تومان (فقط عدد) بفرستید:",
                'author'    => "نام نویسنده/مدرس جدید را بفرستید:",
                'image'     => "URL تصویر جدید را بفرستید:",
                'inventory' => "موجودی جدید را (فقط عدد) بفرستید:",
            ];
            sendMessage($chat_id, "✏️ ویرایش <b>{$f}</b> برای محصول #{$pid}\n\n" . $prompts[$f] . "\n(برای لغو /cancel)");
            log_tg("CB_HANDLED: start edit field={$f} pid={$pid}");
            exit;
        }
    }

    // تغییر دسته: نمایش لیست
    if (strpos($callback_data, 'admin_edit_change_cat_') === 0) {
        $pid = (int)str_replace('admin_edit_change_cat_', '', $callback_data);

        $categories = query("SELECT", "categories", false, [["key"=>"status","condition"=>"=","value"=>"enable"]], true);
        if (!$categories || count($categories) === 0) {
            sendMessage($chat_id, "❌ هیچ دسته فعالی وجود ندارد.");
            sendAdminPanelMenu($chat_id);
            log_tg("CB_ERR: no categories to change pid={$pid}");
            exit;
        }
        $option = [];
        foreach ($categories as $cat) {
            $label = (($cat->icon ?? '') ?: '📂') . ' ' . $cat->name;
            $option[] = [ $telegram->buildInlineKeyBoardButton($label, '', 'admin_edit_set_cat_' . $pid . '_' . (int)$cat->id) ];
        }
        $option[] = [ $telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_edit_menu_' . $pid) ];
        $keyb = $telegram->buildInlineKeyBoard($option);
        sendMessage($chat_id, "🔁 دسته‌ی جدید را برای محصول #{$pid} انتخاب کنید:", $keyb);
        log_tg("CB_HANDLED: change_cat menu pid={$pid}");
        exit;
    }

    // ست‌کردن دسته جدید
    if (strpos($callback_data, 'admin_edit_set_cat_') === 0) {
        // الگو: admin_edit_set_cat_{pid}_{catid}
        $parts = explode('_', $callback_data);
        $pid   = (int)($parts[4] ?? 0);
        $catid = (int)($parts[5] ?? 0);

        if ($pid > 0 && $catid > 0) {
            query("UPDATE", "products", ["category_id" => $catid], [["key"=>"id","condition"=>"=","value"=>$pid]]);
            sendMessage($chat_id, "✅ دسته‌ی محصول #{$pid} تغییر کرد به {$catid}.");
            showProductInfo($chat_id, $pid, 'view', $mesasge_id);
            log_tg("CB_HANDLED: set_cat pid={$pid} cat={$catid}");
            exit;
        }
        sendMessage($chat_id, "❌ داده‌ی نامعتبر برای تغییر دسته.");
        log_tg("CB_ERR: set_cat invalid data");
        exit;
    }

    // تغییر وضعیت enable/disable
    if (strpos($callback_data, 'admin_edit_toggle_status_') === 0) {
        $pid = (int)str_replace('admin_edit_toggle_status_', '', $callback_data);
        $p = query("SELECT", "products", false, [["key"=>"id","condition"=>"=","value"=>$pid]]);
        if (!$p) {
            sendMessage($chat_id, "❌ محصول یافت نشد.");
            log_tg("CB_ERR: toggle_status product not found pid={$pid}");
            exit;
        }
        $new_status = ($p->status === 'enable') ? 'disable' : 'enable';
        query("UPDATE", "products", ["status" => $new_status], [["key"=>"id","condition"=>"=","value"=>$pid]]);
        sendMessage($chat_id, "✅ وضعیت محصول #{$pid} به <b>{$new_status}</b> تغییر کرد.");
        showProductInfo($chat_id, $pid, 'view', $mesasge_id);
        log_tg("CB_HANDLED: toggle_status pid={$pid} -> {$new_status}");
        exit;
    }

    // مرحله ۶: انتخاب دسته هنگام افزودن محصول
    if (strpos($callback_data, 'admin_p_select_cat_') === 0) {
        $category_id = (int)str_replace('admin_p_select_cat_', '', $callback_data);
        log_tg("STEP6_BEGIN: cat={$category_id}");

        try {
            $admin_state = query("SELECT", "admin_process_state", false, [
                ["key"=>"admin_user_id","condition"=>"=","value"=>$chat_id],
                ["key"=>"process_name","condition"=>"=","value"=>"add_product"]
            ], false, "id DESC");

            if (!$admin_state) {
                log_tg("STEP6_ERR: no admin_state for chat={$chat_id}");
                sendMessage($chat_id, "❌ فرایند افزودن محصول یافت نشد. دوباره شروع کنید.");
                sendAdminPanelMenu($chat_id);
                exit;
            }

            log_tg("STEP6_STATE: id={$admin_state->id} step={$admin_state->step} pname={$admin_state->process_name}");

            $step_data = json_decode($admin_state->step_data ?? "{}", true) ?: [];
            $title  = trim($step_data['title'] ?? '');
            $desc   = trim($step_data['description'] ?? '');
            $price  = (int)($step_data['price'] ?? 0);
            $author = trim($step_data['author'] ?? '');
            $image  = trim($step_data['image_url'] ?? '');
            $inventory = isset($step_data['inventory']) ? (int)$step_data['inventory'] : 0;

            log_tg("STEP6_DATA: title=".mb_substr($title,0,40)." price={$price} author=".mb_substr($author,0,40)." image=".mb_substr($image,0,60)." inv={$inventory}");

            $new_id = query("CREATE", "products", [
                'title'       => $title,
                'description' => $desc,
                'price'       => $price,
                'author'      => $author,
                'image_url'   => $image,
                'category_id' => $category_id,
                'inventory'   => $inventory,
                'status'      => 'enable'
            ]);

            log_tg("STEP6_CREATED: product_id={$new_id}");

            $stmt = $conn->prepare("DELETE FROM admin_process_state WHERE id = :id");
            $stmt->execute([':id' => $admin_state->id]);
            log_tg("STEP6_STATE_DELETED: id={$admin_state->id}");

            sendMessage($chat_id, "✅ محصول '<b>" . htmlspecialchars($title, ENT_QUOTES, 'UTF-8') . "</b>' با موفقیت اضافه شد.");
            sendAdminPanelMenu($chat_id);
            log_tg("STEP6_DONE");
            exit;

        } catch (\Throwable $e) {
            $msg = $e->getMessage();
            log_tg("STEP6_EXCEPTION: ".$msg);
            if ($conn instanceof PDO) {
                $ei = $conn->errorInfo();
                if (is_array($ei)) {
                    log_tg("STEP6_PDO: sqlstate={$ei[0]} driver={$ei[1]} msg={$ei[2]}");
                }
            }
            sendMessage($chat_id, "❌ خطا هنگام ثبت محصول. لطفاً دوباره تلاش کنید یا /cancel بزنید.");
            sendAdminPanelMenu($chat_id);
            exit;
        }
    }

    /* =================== گفتگو ادمین با خریدار =================== */
    // شروع گفتگو با خریدار: admin_contact_buyer_{order_id}
    if (strpos($callback_data, 'admin_contact_buyer_') === 0) {
        $oid = (int)str_replace('admin_contact_buyer_', '', $callback_data);

        $order = query("SELECT", "orders", false, [["key"=>"id","condition"=>"=","value"=>$oid]]);
        if (!$order) {
            sendMessage($chat_id, "❌ سفارش یافت نشد.");
            log_tg("CB_ERR: contact_buyer order not found oid={$oid}");
            exit;
        }

        // 1) گرفتن chat_id خریدار
        $buyer_chat_id = (int)($order->user_chat_id ?? 0);
        if ($buyer_chat_id <= 0 && !empty($order->user_id)) {
            // تلاش از جدول users (در صورت وجود)
            $u = query("SELECT", "users", false, [["key"=>"id","condition"=>"=","value"=>$order->user_id]]);
            $buyer_chat_id = (int)($u->chat_id ?? 0);
        }
        if ($buyer_chat_id <= 0) {
            sendMessage($chat_id, "⚠️ chat_id مشتری در سفارش ذخیره نشده است.");
            log_tg("CB_ERR: contact_buyer no chat_id oid={$oid}");
            exit;
        }

        // 2) پاک‌سازی state قبلی
        $stmt = $conn->prepare("DELETE FROM admin_process_state WHERE (admin_user_id=:a AND process_name='admin_msg_buyer') OR (admin_user_id=:b AND process_name='buyer_reply')");
        $stmt->execute([':a' => $chat_id, ':b' => $buyer_chat_id]);

        // 3) ساخت state برای ادمین (ارسال پیام)
        query("CREATE", "admin_process_state", [
            "admin_user_id" => $chat_id,
            "process_name"  => "admin_msg_buyer",
            "step"          => "await",
            "step_data"     => json_encode([
                "order_id"      => $oid,
                "buyer_chat_id" => $buyer_chat_id
            ], JSON_UNESCAPED_UNICODE)
        ]);

        // 4) ساخت state برای خریدار (پاسخ)
        query("CREATE", "admin_process_state", [
            "admin_user_id" => $buyer_chat_id,
            "process_name"  => "buyer_reply",
            "step"          => "await",
            "step_data"     => json_encode([
                "order_id"      => $oid,
                "admin_chat_id" => $chat_id
            ], JSON_UNESCAPED_UNICODE)
        ]);

        // 5) راهنمای ادمین
        $kb = $telegram->buildInlineKeyBoard([
            [ $telegram->buildInlineKeyBoardButton("🔚 پایان گفتگو", '', 'admin_close_dialog_' . $buyer_chat_id) ]
        ]);
        sendMessage($chat_id, "✍️ پیام‌تان را برای خریدار بفرستید.\nمی‌توانید <b>متن</b> یا <b>عکس با کپشن</b> ارسال کنید.\n(برای لغو /cancel)", $kb);
        log_tg("CB_HANDLED: contact_buyer oid={$oid} buyer={$buyer_chat_id}");
        exit;
    }

    // بستن گفتگو: admin_close_dialog_{buyer_chat_id}
    if (strpos($callback_data, 'admin_close_dialog_') === 0) {
        $bchat = (int)str_replace('admin_close_dialog_', '', $callback_data);
        $stmt = $conn->prepare("DELETE FROM admin_process_state WHERE (admin_user_id=:a AND process_name='admin_msg_buyer') OR (admin_user_id=:b AND process_name='buyer_reply')");
        $stmt->execute([':a' => $chat_id, ':b' => $bchat]);
        sendMessage($chat_id, "🔒 گفتگو بسته شد.");
        log_tg("CB_HANDLED: close_dialog buyer={$bchat}");
        exit;
    }

    // لغو عملیات
    if ($callback_data === 'admin_cancel_process') {
        $stmt = $conn->prepare("DELETE FROM admin_process_state WHERE admin_user_id = :cid");
        $stmt->execute([':cid' => $chat_id]);
        sendMessage($chat_id, "✅ عملیات لغو شد.");
        sendAdminPanelMenu($chat_id);
        log_tg("CB_HANDLED: admin_cancel_process");
        exit;
    }

    // سایر
    sendMessage($chat_id, "این بخش در حال توسعه است.", false, $mesasge_id);
    log_tg("CB_FALLBACK: {$callback_data}");
    exit;
}

/* ======================================================================
   پردازش پیام متنی (یک‌بار)
   ====================================================================== */
if ($text_message || !empty($update['message'])) {
    if ($text_message) {
        log_tg("MSG_RECEIVED: chat={$chat_id} text=".mb_substr($text_message,0,64));
    } else {
        log_tg("MSG_RECEIVED: chat={$chat_id} type=".implode(',', array_keys($update['message'])));
    }

    if ($text_message === '/cancel') {
        $stmt = $conn->prepare("DELETE FROM admin_process_state WHERE admin_user_id = :cid");
        $stmt->execute([':cid' => $chat_id]);
        sendMessage($chat_id, "✅ عملیات لغو شد.");
        sendAdminPanelMenu($chat_id);
        log_tg("MSG_HANDLED: cancel");
        exit;
    }

    if ($text_message === '/admin') {
        sendAdminPanelMenu($chat_id, $mesasge_id);
        log_tg("MSG_HANDLED: open admin panel");
        exit;
    }

    // 🔧 اینجا state بر اساس admin_user_id همان chat_id فعلی لود می‌شود
    $admin_state = query(
        "SELECT",
        "admin_process_state",
        false,
        [
            ["key"=>"admin_user_id","condition"=>"=","value"=>$chat_id]
        ],
        false,
        "id DESC"
    );
    if (!$admin_state) {
        log_tg("MSG_INFO: no active state");
        // اگر هیچ state ای نبود، ولی ممکنه این پیام پاسخ خریدار باشد که state اش قبلا پاک شده؟
        // اینجا می‌تونید رفتار آزاد داشته باشید. فعلاً خروج.
        exit;
    }

    $process_name = $admin_state->process_name;
    $step         = (string)$admin_state->step; // ممکن است عدد یا رشته باشد
    $step_data    = json_decode($admin_state->step_data ?? "{}", true) ?: [];

    /* ----------------- افزودن دسته ----------------- */
    if ($process_name === 'add_category') {
        if ($step === '1') {
            $step_data['name'] = $text_message;
            query("UPDATE", "admin_process_state",
                ["step" => 2, "step_data" => json_encode($step_data, JSON_UNESCAPED_UNICODE)],
                [["key"=>"id","condition"=>"=","value"=>$admin_state->id]]
            );
            sendMessage($chat_id, "<b>مرحله ۲:</b>\n\nیک آیکون (ایموجی) برای دسته‌بندی بفرستید (مثال: ✨)\n(برای لغو /cancel)");
            log_tg("STATE: add_category -> step 2");
            exit;
        } elseif ($step === '2') {
            $step_data['icon'] = $text_message;
            query("CREATE", "categories", [
                "name"   => $step_data['name'],
                "icon"   => $step_data['icon'],
                "status" => "enable"
            ]);
            $conn->prepare("DELETE FROM admin_process_state WHERE id = :id")->execute([':id' => $admin_state->id]);
            sendMessage($chat_id, "✅ دسته‌بندی '<b>{$step_data['name']}</b>' با موفقیت اضافه شد.");
            sendAdminPanelMenu($chat_id);
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
                sendMessage($chat_id, "❌ لطفاً قیمت را فقط به صورت عدد وارد کنید.");
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
            sendMessage($chat_id, "<b>مرحله ۵:</b>\n\nآدرس URL تصویر محصول را وارد کنید:\n(برای لغو /cancel)");
            log_tg("STATE: add_product -> step 5");
            exit;
        } elseif ($step === '5') {
            $step_data['image_url'] = $text_message;
            query("UPDATE", "admin_process_state",
                ["step" => 6, "step_data" => json_encode($step_data, JSON_UNESCAPED_UNICODE)],
                [["key"=>"id","condition"=>"=","value"=>$admin_state->id]]
            );

            $categories = query("SELECT", "categories", false, [
                ["key" => "status", "condition" => "=", "value" => "enable"]
            ], true);

            if (!$categories || count($categories) === 0) {
                $conn->prepare("DELETE FROM admin_process_state WHERE id = :id")->execute([':id' => $admin_state->id]);
                sendMessage($chat_id, "❌ هیچ دسته‌بندی فعالی وجود ندارد. ابتدا یک دسته‌بندی ایجاد کنید.");
                sendAdminPanelMenu($chat_id);
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
            sendMessage($chat_id, "<b>مرحله نهایی (۶):</b>\n\nدسته‌بندی این محصول را انتخاب کنید:", $keyb);
            log_tg("STATE: add_product -> step 6 (await category)");
            exit;
        }
    }

    /* ----------------- ویرایش محصول (text) ----------------- */
    if ($process_name === 'edit_product') {
        $field    = (string)$step; // نام فیلد (رشته)
        $pid      = (int)($step_data['product_id'] ?? 0);

        if ($pid <= 0) {
            sendMessage($chat_id, "❌ محصول نامعتبر.");
            log_tg("EDIT_ERR: invalid pid in state");
            exit;
        }

        $value = isset($text_message) ? trim($text_message) : null;

        if ($field === 'price' || $field === 'inventory') {
            if (!is_numeric($value)) {
                sendMessage($chat_id, "❌ لطفاً مقدار عددی معتبر وارد کنید.");
                log_tg("EDIT_ERR: non-numeric for {$field} pid={$pid}");
                exit;
            }
            $value = (int)$value;
        }

        $map = [
            'title'      => 'title',
            'description'=> 'description',
            'price'      => 'price',
            'author'     => 'author',
            'image'      => 'image_url',
            'inventory'  => 'inventory',
        ];

        if (!isset($map[$field])) {
            sendMessage($chat_id, "❌ فیلد ناشناخته برای ویرایش.");
            log_tg("EDIT_ERR: unknown field={$field}");
            exit;
        }

        query("UPDATE", "products", [ $map[$field] => $value ], [["key"=>"id","condition"=>"=","value"=>$pid]]);

        $conn->prepare("DELETE FROM admin_process_state WHERE id = :id")->execute([':id' => $admin_state->id]);
        sendMessage($chat_id, "✅ مقدار <b>{$field}</b> محصول #{$pid} بروزرسانی شد.");
        showProductInfo($chat_id, $pid, 'view', $mesasge_id);
        log_tg("EDIT_DONE: field={$field} pid={$pid} value=".mb_substr((string)$value,0,60));
        exit;
    }

    /* ----------------- گفتگو ادمین با خریدار ----------------- */
    if ($process_name === 'admin_msg_buyer') {
        $buyer_chat_id = (int)($step_data['buyer_chat_id'] ?? 0);
        $order_id      = (int)($step_data['order_id'] ?? 0);

        if ($buyer_chat_id <= 0) {
            sendMessage($chat_id, "❌ گیرنده معتبر نیست.");
            log_tg("DIALOG_ERR: admin_msg_buyer no buyer_chat_id");
            exit;
        }

        // تشخیص عکس یا متن:
        $photo_id = extract_photo_from_update($update);
        $caption  = extract_caption_from_update($update);

        if ($photo_id) {
            $telegram->sendPhoto([
                'chat_id'    => $buyer_chat_id,
                'photo'      => $photo_id,
                'caption'    => $caption ? "📣 پیام پشتیبانی:\n".$caption : "📣 پیام پشتیبانی",
                'parse_mode' => 'HTML'
            ]);
        } elseif (!empty($text_message)) {
            sendMessage(
                $buyer_chat_id,
                "📣 <b>پیام از پشتیبانی:</b>\n\n" . $text_message
            );
        } else {
            sendMessage($chat_id, "⚠️ فقط متن یا عکس را بفرستید.");
            log_tg("DIALOG_WARN: admin_msg_buyer unknown payload");
            exit;
        }

        // دکمه پایان گفتگو
        $kb = $telegram->buildInlineKeyBoard([
            [ $telegram->buildInlineKeyBoardButton("🔚 پایان گفتگو", '', 'admin_close_dialog_' . $buyer_chat_id) ]
        ]);
        sendMessage($chat_id, "✅ پیام برای خریدار ارسال شد.", $kb);
        log_tg("DIALOG_INFO: sent to buyer={$buyer_chat_id} by admin={$chat_id} order={$order_id}");
        exit;
    }

    if ($process_name === 'buyer_reply') {
        // این مسیر وقتی فعال است که پیام از سمت خریدار بیاید
        $admin_id = (int)($step_data['admin_chat_id'] ?? 0);
        $order_id = (int)($step_data['order_id'] ?? 0);

        if ($admin_id <= 0) {
            // اگر به هر دلیل admin مشخص نبود، state را پاک کنیم
            $conn->prepare("DELETE FROM admin_process_state WHERE id = :id")->execute([':id' => $admin_state->id]);
            log_tg("DIALOG_ERR: buyer_reply no admin_id");
            exit;
        }

        $photo_id = extract_photo_from_update($update);
        $caption  = extract_caption_from_update($update);

        if ($photo_id) {
            $telegram->sendPhoto([
                'chat_id'    => $admin_id,
                'photo'      => $photo_id,
                'caption'    => "📥 پاسخ خریدار (Order #{$order_id}):\n".$caption,
                'parse_mode' => 'HTML'
            ]);
        } elseif (!empty($text_message)) {
            sendMessage($admin_id, "📥 <b>پاسخ خریدار</b> (Order #{$order_id}):\n\n".$text_message);
        } else {
            // نوع پیام ناشناخته؛ نادیده بگیر
            log_tg("DIALOG_WARN: buyer_reply unknown payload");
        }

        // به خریدار هم اطلاع بدهیم که پیامش رسید (اختیاری)
        // sendMessage($chat_id, "✅ پیام شما برای پشتیبانی ارسال شد.");

        log_tg("DIALOG_INFO: buyer={$chat_id} -> admin={$admin_id} order={$order_id}");
        exit;
    }

    // خارج از فرایند
    log_tg("MSG_INFO: fell through");
    exit;
}
