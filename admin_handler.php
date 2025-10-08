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

/* ---------- کمک‌توابع کیبورد ---------- */
function send_quick_admin_reply_keyboard($chat_id) {
    // یک کیبورد همیشگی با دکمه /admin
    global $telegram;
    if (!method_exists($telegram, 'buildKeyBoard')) return;
    $rkey = $telegram->buildKeyBoard(
        [[ "/admin" ]],
        $onetime=false,
        $resize=true,
        $selective=false
    );
    sendMessage($chat_id, "می‌تونی هر زمان خواستی از دکمه /admin پایین استفاده کنی.", $rkey);
}

function build_back_to_admin_panel_inline() {
    global $telegram;
    return $telegram->buildInlineKeyBoard([[ $telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_root') ]]);
}

/* --- بستن لودینگ کال‌بک برای UX بهتر --- */
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
   منوی روت ادمین (Inline) — مستقل از admin_functions.php
   ====================================================================== */
function sendAdminRootMenu($chat_id, $mesasge_id = false) {
    global $telegram;
    $kb = $telegram->buildInlineKeyBoard([
        [ $telegram->buildInlineKeyBoardButton("📊 آمار", '', 'admin_stats'),
          $telegram->buildInlineKeyBoardButton("➕ افزودن دسته‌بندی", '', 'admin_add_category') ],
        [ $telegram->buildInlineKeyBoardButton("➕ افزودن محصول", '', 'admin_add_product') ],
        [ $telegram->buildInlineKeyBoardButton("✏️ ویرایش محصول (همه)", '', 'admin_edit_product_all'),
          $telegram->buildInlineKeyBoardButton("🗑️ حذف محصول", '', 'admin_delete_product') ],
        [ $telegram->buildInlineKeyBoardButton("📂 مدیریت دسته‌بندی‌ها", '', 'admin_manage_categories') ],
        [ $telegram->buildInlineKeyBoardButton("🧾 سفارشات پرداخت‌شده", '', 'admin_orders_paid') ],
        [ $telegram->buildInlineKeyBoardButton("🏠 منوی اصلی", '', 'start') ],
    ]);
    $txt = "🔐 <b>پنل مدیریت</b>\n\nیکی از گزینه‌ها را انتخاب کن:";
    sendMessage($chat_id, $txt, $kb, $mesasge_id);
}

/* ======================================================================
   لیست‌سازها داخل همین فایل (برای دور زدن محدودیت «فقط فعال‌ها»)
   ====================================================================== */
function listAllProductsForEdit($chat_id, $mesasge_id=false) {
    global $telegram;
    $rows = query("SELECT", "products", false, false, true, "id DESC"); // همه، بدون فیلتر وضعیت
    if (!$rows || !count($rows)) {
        sendMessage($chat_id, "❌ محصولی وجود ندارد.", build_back_to_admin_panel_inline(), $mesasge_id);
        return;
    }
    $opt = [];
    foreach ($rows as $p) {
        $status = ($p->status==='enable'?'✅':'⛔');
        $btn = $status." ".mb_substr($p->title,0,32)." (ID:".$p->id.")";
        $opt[] = [ $telegram->buildInlineKeyBoardButton($btn, '', 'admin_edit_select_'.$p->id) ];
    }
    $opt[] = [ $telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_root') ];
    $kb = $telegram->buildInlineKeyBoard($opt);
    sendMessage($chat_id, "✏️ <b>ویرایش محصول</b> — لیست همه‌ی محصولات:", $kb, $mesasge_id);
}

function listPaidOrders($chat_id, $mesasge_id=false) {
    global $telegram, $conn;
    $sql = "SELECT id, user_id, user_chat_id, status, created_at FROM orders WHERE status='payed' ORDER BY id DESC LIMIT 100";
    $stm = $conn->query($sql);
    $rows = $stm ? $stm->fetchAll(PDO::FETCH_OBJ) : [];
    if (!$rows) {
        sendMessage($chat_id, "هیچ سفارش پرداخت‌شده‌ای پیدا نشد.", build_back_to_admin_panel_inline(), $mesasge_id);
        return;
    }
    $opt=[];
    foreach ($rows as $o) {
        $cap = "🧾 #".$o->id." — ".($o->status)." — ".mb_substr((string)$o->created_at,0,19);
        $opt[] = [ $telegram->buildInlineKeyBoardButton($cap, '', 'admin_order_view_'.$o->id) ];
    }
    $opt[] = [ $telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_root') ];
    $kb = $telegram->buildInlineKeyBoard($opt);
    sendMessage($chat_id, "<b>سفارشات پرداخت‌شده</b> (حداکثر ۱۰۰ مورد اخیر):", $kb, $mesasge_id);
}

function showOrderDetailsToAdmin($chat_id, $order_id, $mesasge_id=false) {
    global $telegram, $conn;
    $order = query("SELECT","orders",false,[["key"=>"id","condition"=>"=","value"=>$order_id]]);
    if (!$order) {
        sendMessage($chat_id, "❌ سفارش یافت نشد.", build_back_to_admin_panel_inline(), $mesasge_id);
        return;
    }
    $details = query("SELECT","order_details",false,[["key"=>"order_id","condition"=>"=","value"=>$order_id]]);
    $sql = "SELECT oi.quantity, p.title, p.price FROM orders_item oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=:oid";
    $st = $conn->prepare($sql); $st->execute([':oid'=>$order_id]); $items = $st->fetchAll(PDO::FETCH_OBJ);

    $txt = "🧾 <b>سفارش #{$order->id}</b>\n";
    if ($details) {
        $txt .= "👤 {$details->first_name} {$details->last_name}\n📍 {$details->address}\n📞 {$details->phone_number}\n";
    }
    $txt .= "وضعیت فعلی: <b>{$order->status}</b>\n";
    $txt .= "──────────────\n<b>آیتم‌ها:</b>\n";
    $total=0;
    foreach ($items as $it){
        $line = "• {$it->title} × {$it->quantity} = ".number_format($it->price*$it->quantity)." ت\n";
        $txt .= $line; $total += $it->price*$it->quantity;
    }
    $txt .= "──────────────\n💰 جمع کل: <b>".number_format($total)." تومان</b>";

    $opt = [];
    // تایید/رد برای ادمین
    if ($order->status!=='approved') {
        $opt[] = [ $telegram->buildInlineKeyBoardButton("✅ تایید سفارش", '', 'admin_order_approve_'.$order->id) ];
    }
    if ($order->status!=='rejected') {
        $opt[] = [ $telegram->buildInlineKeyBoardButton("❌ رد سفارش", '', 'admin_order_reject_'.$order->id) ];
    }
    // پیام به خریدار (اگر chat_id داریم)
    $opt[] = [ $telegram->buildInlineKeyBoardButton("✉️ پیام به خریدار", '', 'admin_contact_buyer_'.$order->id) ];
    $opt[] = [ $telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_orders_paid') ];
    $kb = $telegram->buildInlineKeyBoard($opt);
    sendMessage($chat_id, $txt, $kb, $mesasge_id);
}

function listCategoriesManage($chat_id, $mesasge_id=false) {
    global $telegram;
    $cats = query("SELECT","categories",false,false,true,"id DESC");
    if (!$cats || !count($cats)) {
        sendMessage($chat_id, "❌ دسته‌بندی‌ای وجود ندارد.", build_back_to_admin_panel_inline(), $mesasge_id);
        return;
    }
    $opt=[];
    foreach ($cats as $c){
        $status = ($c->status==='enable' ? '✅' : '⛔');
        $name = (($c->icon ?? '')?:'📂').' '.$c->name;
        $opt[] = [ 
            $telegram->buildInlineKeyBoardButton($status." ".$name, '', 'noop'),
            $telegram->buildInlineKeyBoardButton(($c->status==='enable'?'غیرفعال‌سازی ⛔':'فعال‌سازی ✅'), '', 'admin_toggle_category_'.$c->id)
        ];
    }
    $opt[] = [ $telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_root') ];
    $kb = $telegram->buildInlineKeyBoard($opt);
    sendMessage($chat_id, "📂 <b>مدیریت دسته‌بندی‌ها</b>:", $kb, $mesasge_id);
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
        if ($callback_data === 'start') sendMainKeyboardMenu($chat_id, $mesasge_id);
        else sendAdminRootMenu($chat_id, $mesasge_id); // به‌جای منوی قدیمی
        log_tg("CB_HANDLED: open_menu {$callback_data}");
        exit;
    }

    // آمار
    if ($callback_data === 'admin_stats') {
        $users_count      = (int)$conn->query("SELECT count(*) FROM users")->fetchColumn();
        $products_count   = (int)$conn->query("SELECT count(*) FROM products")->fetchColumn();
        $completed_orders = (int)$conn->query("SELECT count(*) FROM orders WHERE status = 'payed'")->fetchColumn();

        $stats_text  = "📊 <b>آمار کلی ربات:</b>\n\n";
        $stats_text .= "👤 کاربران: <b>{$users_count}</b>\n";
        $stats_text .= "📦 محصولات: <b>{$products_count}</b>\n";
        $stats_text .= "✅ سفارشات پرداخت‌شده: <b>{$completed_orders}</b>\n";

        $keyb = build_back_to_admin_panel_inline();
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

    // لیست ویرایش/حذف قدیمی (حذف را همان قبلی می‌گذاریم)
    if ($callback_data === 'admin_delete_product') {
        sendAdminProductList($chat_id, 'delete_product', $mesasge_id); // از فایل قبلی‌ات
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
        sendMessage($chat_id, "✅ محصول <b>#{$pid}</b> غیرفعال شد.", build_back_to_admin_panel_inline(), $mesasge_id);
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
            [ $telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_edit_product_all') ],
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
                "step"          => $f,
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
            sendMessage($chat_id, "❌ هیچ دسته فعالی وجود ندارد.", build_back_to_admin_panel_inline());
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
        $parts = explode('_', $callback_data);
        $pid   = (int)($parts[4] ?? 0);
        $catid = (int)($parts[5] ?? 0);

        if ($pid > 0 && $catid > 0) {
            query("UPDATE", "products", ["category_id" => $catid], [["key"=>"id","condition"=>"=","value"=>$pid]]);
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
        $pid = (int)str_replace('admin_edit_toggle_status_', '', $callback_data);
        $p = query("SELECT", "products", false, [["key"=>"id","condition"=>"=","value"=>$pid]]);
        if (!$p) {
            sendMessage($chat_id, "❌ محصول یافت نشد.", build_back_to_admin_panel_inline());
            log_tg("CB_ERR: toggle_status product not found pid={$pid}");
            exit;
        }
        $new_status = ($p->status === 'enable') ? 'disable' : 'enable';
        query("UPDATE", "products", ["status" => $new_status], [["key"=>"id","condition"=>"=","value"=>$pid]]);
        sendMessage($chat_id, "✅ وضعیت محصول #{$pid} به <b>{$new_status}</b> تغییر کرد.", build_back_to_admin_panel_inline());
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
                sendMessage($chat_id, "❌ فرایند افزودن محصول یافت نشد. دوباره شروع کنید.", build_back_to_admin_panel_inline());
                exit;
            }

            $step_data = json_decode($admin_state->step_data ?? "{}", true) ?: [];
            $title  = trim($step_data['title'] ?? '');
            $desc   = trim($step_data['description'] ?? '');
            $price  = (int)($step_data['price'] ?? 0);
            $author = trim($step_data['author'] ?? '');
            $image  = trim($step_data['image_url'] ?? '');
            $inventory = isset($step_data['inventory']) ? (int)$step_data['inventory'] : 0;

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

            $stmt = $conn->prepare("DELETE FROM admin_process_state WHERE id = :id");
            $stmt->execute([':id' => $admin_state->id]);

            sendMessage($chat_id, "✅ محصول '<b>" . htmlspecialchars($title, ENT_QUOTES, 'UTF-8') . "</b>' اضافه شد.", build_back_to_admin_panel_inline());
            log_tg("STEP6_CREATED: product_id={$new_id}");
            exit;

        } catch (\Throwable $e) {
            log_tg("STEP6_EXCEPTION: ".$e->getMessage());
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
        $cid = (int)str_replace('admin_toggle_category_', '', $callback_data);
        $cat = query("SELECT","categories",false,[["key"=>"id","condition"=>"=","value"=>$cid]]);
        if (!$cat) {
            sendMessage($chat_id,"❌ دسته‌بندی یافت نشد.", build_back_to_admin_panel_inline());
            exit;
        }
        $new = ($cat->status==='enable'?'disable':'enable');
        query("UPDATE","categories",["status"=>$new],[["key"=>"id","condition"=>"=","value"=>$cid]]);
        sendMessage($chat_id,"✅ وضعیت دسته «{$cat->name}» به <b>{$new}</b> تغییر کرد.");
        listCategoriesManage($chat_id);
        exit;
    }

    /* =================== سفارشات پرداخت‌شده + تایید/رد =================== */
    if ($callback_data === 'admin_orders_paid') {
        listPaidOrders($chat_id, $mesasge_id);
        exit;
    }
    if (strpos($callback_data,'admin_order_view_')===0){
        $oid=(int)str_replace('admin_order_view_','',$callback_data);
        showOrderDetailsToAdmin($chat_id,$oid,$mesasge_id);
        exit;
    }
    if (strpos($callback_data,'admin_order_approve_')===0){
        $oid=(int)str_replace('admin_order_approve_','',$callback_data);
        query("UPDATE","orders",["status"=>"approved"],[["key"=>"id","condition"=>"=","value"=>$oid]]);
        sendMessage($chat_id,"✅ سفارش #{$oid} تایید شد.");
        showOrderDetailsToAdmin($chat_id,$oid);
        exit;
    }
    if (strpos($callback_data,'admin_order_reject_')===0){
        $oid=(int)str_replace('admin_order_reject_','',$callback_data);
        query("UPDATE","orders",["status"=>"rejected"],[["key"=>"id","condition"=>"=","value"=>$oid]]);
        sendMessage($chat_id,"❌ سفارش #{$oid} رد شد.");
        showOrderDetailsToAdmin($chat_id,$oid);
        exit;
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

        // گرفتن chat_id خریدار
        $buyer_chat_id = (int)($order->user_chat_id ?? 0);
        if ($buyer_chat_id <= 0 && !empty($order->user_id)) {
            $u = query("SELECT", "users", false, [["key"=>"id","condition"=>"=","value"=>$order->user_id]]);
            $buyer_chat_id = (int)($u->chat_id ?? 0);
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
            "process_name"  => "admin_msg_buyer",
            "step"          => "await",
            "step_data"     => json_encode([
                "order_id"      => $oid,
                "buyer_chat_id" => $buyer_chat_id
            ], JSON_UNESCAPED_UNICODE)
        ]);

        // ساخت state برای خریدار (پاسخ)
        query("CREATE", "admin_process_state", [
            "admin_user_id" => $buyer_chat_id,
            "process_name"  => "buyer_reply",
            "step"          => "await",
            "step_data"     => json_encode([
                "order_id"      => $oid,
                "admin_chat_id" => $chat_id
            ], JSON_UNESCAPED_UNICODE)
        ]);

        // راهنمای ادمین
        $kb = $telegram->buildInlineKeyBoard([
            [ $telegram->buildInlineKeyBoardButton("🔚 پایان گفتگو", '', 'admin_close_dialog_' . $buyer_chat_id) ],
            [ $telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_root') ],
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
        log_tg("MSG_RECEIVED: chat={$chat_id} text=".mb_substr($text_message,0,64));
    } else {
        log_tg("MSG_RECEIVED: chat={$chat_id} type=".implode(',', array_keys($update['message'])));
    }

    if ($text_message === '/cancel') {
        $stmt = $conn->prepare("DELETE FROM admin_process_state WHERE admin_user_id = :cid");
        $stmt->execute([':cid' => $chat_id]);
        sendMessage($chat_id, "✅ عملیات لغو شد.", build_back_to_admin_panel_inline());
        log_tg("MSG_HANDLED: cancel");
        exit;
    }

    if ($text_message === '/admin') {
        sendAdminRootMenu($chat_id, $mesasge_id);
        // کیبورد همیشگی /admin را هم بفرستیم (یک‌بار هر بار)
        send_quick_admin_reply_keyboard($chat_id);
        log_tg("MSG_HANDLED: open admin root (internal)");
        exit;
    }

    // لود state برای chat_id فعلی
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
        exit;
    }

    $process_name = $admin_state->process_name;
    $step         = (string)$admin_state->step;
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
            sendMessage($chat_id, "❌ محصول نامعتبر.", build_back_to_admin_panel_inline());
            log_tg("EDIT_ERR: invalid pid in state");
            exit;
        }

        $value = isset($text_message) ? trim($text_message) : null;

        if ($field === 'price' || $field === 'inventory') {
            if (!is_numeric($value)) {
                sendMessage($chat_id, "❌ لطفاً مقدار عددی معتبر وارد کنید.", build_back_to_admin_panel_inline());
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
            sendMessage($chat_id, "❌ فیلد ناشناخته برای ویرایش.", build_back_to_admin_panel_inline());
            log_tg("EDIT_ERR: unknown field={$field}");
            exit;
        }

        query("UPDATE", "products", [ $map[$field] => $value ], [["key"=>"id","condition"=>"=","value"=>$pid]]);

        $conn->prepare("DELETE FROM admin_process_state WHERE id = :id")->execute([':id' => $admin_state->id]);
        sendMessage($chat_id, "✅ مقدار <b>{$field}</b> محصول #{$pid} بروزرسانی شد.", build_back_to_admin_panel_inline());
        showProductInfo($chat_id, $pid, 'view', $mesasge_id);
        log_tg("EDIT_DONE: field={$field} pid={$pid} value=".mb_substr((string)$value,0,60));
        exit;
    }

    /* ----------------- گفتگو ادمین با خریدار ----------------- */
    if ($process_name === 'admin_msg_buyer') {
        $buyer_chat_id = (int)($step_data['buyer_chat_id'] ?? 0);
        $order_id      = (int)($step_data['order_id'] ?? 0);

        if ($buyer_chat_id <= 0) {
            sendMessage($chat_id, "❌ گیرنده معتبر نیست.", build_back_to_admin_panel_inline());
            log_tg("DIALOG_ERR: admin_msg_buyer no buyer_chat_id");
            exit;
        }

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
            sendMessage($chat_id, "⚠️ فقط متن یا عکس را بفرستید.", build_back_to_admin_panel_inline());
            log_tg("DIALOG_WARN: admin_msg_buyer unknown payload");
            exit;
        }

        $kb = $telegram->buildInlineKeyBoard([
            [ $telegram->buildInlineKeyBoardButton("🔚 پایان گفتگو", '', 'admin_close_dialog_' . $buyer_chat_id) ],
            [ $telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_root') ],
        ]);
        sendMessage($chat_id, "✅ پیام برای خریدار ارسال شد.", $kb);
        log_tg("DIALOG_INFO: sent to buyer={$buyer_chat_id} by admin={$chat_id} order={$order_id}");
        exit;
    }

    if ($process_name === 'buyer_reply') {
        $admin_id = (int)($step_data['admin_chat_id'] ?? 0);
        $order_id = (int)($step_data['order_id'] ?? 0);

        if ($admin_id <= 0) {
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
            log_tg("DIALOG_WARN: buyer_reply unknown payload");
        }

        log_tg("DIALOG_INFO: buyer={$chat_id} -> admin={$admin_id} order={$order_id}");
        exit;
    }

    // خارج از فرایند
    log_tg("MSG_INFO: fell through");
    exit;
}
