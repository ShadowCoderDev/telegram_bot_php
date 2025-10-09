<?php
// admin_functions.php
global $conn, $telegram, $resultTelegram, $chat_id, $mesasge_id;

/* =================== ADMIN FUNCTIONS =================== */


/**
 * نمایش لیست محصولات برای ویرایش یا حذف
 * نکته: برای حذف اول صفحه‌ی تایید می‌آوریم => callback 'admin_delete_select_{id}'
 */
function sendAdminProductList($chat_id, $action, $mesasge_id = false)
{
    global $telegram;

    // ✅ مرحله ۱: فیلتر status حذف شد تا همه محصولات نمایش داده شوند
    $products = query("SELECT", "products", false, false, true, "id DESC");

    if (!$products || count($products) == 0) {
        $keyb = $telegram->buildInlineKeyBoard([[$telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_root')]]);
        return sendMessage($chat_id, "❌ هیچ محصولی برای حذف وجود ندارد.", $keyb, $mesasge_id);
    }

    $option = [];
    $callback_prefix = ($action == 'edit_product') ? 'admin_edit_select_' : 'admin_delete_select_';
    $title_action = ($action == 'edit_product') ? '✏️ ویرایش' : '🗑️ حذف';

    foreach ($products as $product) {
        // ✅ مرحله ۲: یک ایموجی برای نمایش وضعیت محصول اضافه شد (فعال/غیرفعال)
        $status_icon = ($product->status == 'enable' ? '✅' : '❌');
        $btn_text = $status_icon . " " . substr($product->title, 0, 30) . " (" . number_format($product->price) . " ت)";
        $option[] = array($telegram->buildInlineKeyBoardButton($btn_text, '', $callback_prefix . $product->id));
    }

    $option[] = array($telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_root'));

    $keyb = $telegram->buildInlineKeyBoard($option);
    $text = $title_action . " - <b>لطفاً محصول را انتخاب کنید:</b>\n\n";
    $text .= "تعداد کل محصولات: <b>" . count($products) . "</b>";

    sendMessage($chat_id, $text, $keyb, $mesasge_id);
}


/**
 * نمایش اطلاعات محصول جهت مشاهده/ویرایش یا تایید حذف
 * دکمه «✏️ ویرایش این محصول» اضافه شد که منوی ویرایش را باز می‌کند.
 */
function showProductInfo($chat_id, $product_id, $action = 'view', $mesasge_id = false)
{
    global $telegram;

    $product = query("SELECT", "products", false, [["key" => "id", "condition" => "=", "value" => $product_id]]);

    if (!$product) {
        $keyb = $telegram->buildInlineKeyBoard([[$telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_root')]]); // بازگشت به منوی جدید
        return sendMessage($chat_id, "❌ محصول یافت نشد.", $keyb, $mesasge_id);
    }

    // ✅ مرحله ۱: نام دسته‌بندی را با استفاده از category_id دریافت می‌کنیم
    $category_name = "<i>تعیین نشده</i>";
    if (!empty($product->category_id)) {
        $category = query("SELECT", "categories", false, [["key" => "id", "condition" => "=", "value" => $product->category_id]]);
        if ($category) {
            $category_name = ($category->icon ?? '📂') . " " . htmlspecialchars($category->name);
        }
    }

    $status_txt = ($product->status == 'enable' ? '✅ فعال' : '❌ غیرفعال');
    $text = "<b>📦 اطلاعات محصول #{$product->id}:</b>\n\n";
    $text .= "<b>نام:</b> " . htmlspecialchars($product->title) . "\n";
    $text .= "<b>توضیحات:</b> " . htmlspecialchars(substr($product->description, 0, 120)) . "...\n";
    $text .= "<b>قیمت:</b> " . number_format((int) $product->price) . " تومان\n";
    $text .= "<b>نویسنده/مدرس:</b> " . htmlspecialchars($product->author) . "\n";
    $text .= "<b>تصویر:</b> " . htmlspecialchars($product->image_url) . "\n";

    // ✅ مرحله ۲: به جای ID، نام دسته‌بندی را نمایش می‌دهیم
    $text .= "<b>دسته:</b> " . $category_name . "\n";

    $text .= "<b>موجودی:</b> " . ((int) ($product->inventory ?? 0)) . "\n";
    $text .= "<b>وضعیت:</b> {$status_txt}\n";

    if ($action == 'delete') {
        $text .= "\n⚠️ <b>آیا از حذف این محصول اطمینان دارید؟</b>";
        $option = array(
            array($telegram->buildInlineKeyBoardButton("✅ بله، حذف کن", '', 'admin_delete_confirm_' . $product->id), $telegram->buildInlineKeyBoardButton("❌ خیر، منصرف شدم", '', 'admin_delete_product')),
        );
    } else {
        $option = array(
            array($telegram->buildInlineKeyBoardButton("✏️ ویرایش این محصول", '', 'admin_edit_menu_' . $product->id)),
            array($telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_edit_product_all')), // بازگشت به لیست محصولات
        );
    }

    $keyb = $telegram->buildInlineKeyBoard($option);
    sendMessage($chat_id, $text, $keyb, $mesasge_id);
}


/**
 * اطلاع‌رسانی ادمین از سفارش جدید (در صورت نیاز)
 */
function notifyAdminOfNewOrder($order_id)
{
    global $telegram, $conn, $ADMIN_CHAT_ID;

    $order = query("SELECT", "orders", false, [["key" => "id", "condition" => "=", "value" => $order_id]]);
    $order_details = query("SELECT", "order_details", false, [["key" => "order_id", "condition" => "=", "value" => $order_id]]);
    if (!$order || !$order_details)
        return;

    $text = "🔔 <b>سفارش جدید ثبت شد!</b> 🔔\n\n";
    $text .= "<b>شماره سفارش:</b> #{$order->id}\n";
    $text .= "<b>کد رهگیری:</b> " . ($order->trackId ?? "#" . $order->id) . "\n";
    $text .= "<b>نام مشتری:</b> {$order_details->first_name} {$order_details->last_name}\n";
    $text .= "<b>آدرس:</b> {$order_details->address}\n";
    $text .= "<b>تلفن:</b> {$order_details->phone_number}\n";
    $text .= "─────────────────\n<b>محصولات سفارش:</b>\n\n";

    $sql = "SELECT quantity, price, product_title FROM `orders_item` WHERE order_id=:oid";
    $stmt = $conn->prepare($sql);
    $stmt->bindValue(':oid', $order_id, PDO::PARAM_INT);
    $stmt->execute();
    $items = $stmt->fetchAll(PDO::FETCH_OBJ);

    $total_price = 0;
    foreach ($items as $item) {
        $text .= "📦 {$item->product_title} (<b>{$item->quantity} عدد</b>)\n";
        $total_price += $item->quantity * $item->price;
    }

    $text .= "─────────────────\n";
    $text .= "💰 <b>جمع کل فاکتور:</b> " . number_format($total_price) . " تومان\n";

    // دکمه پیام به خریدار
    global $telegram;

    $option = [];
    $row1 = [];
    $row2 = [];

    // اضافه کردن دکمه‌های تایید و رد بر اساس وضعیت فعلی
    if ($order->status !== 'approved') {
        $row1[] = $telegram->buildInlineKeyBoardButton("✅ تایید", '', 'admin_order_approve_' . $order->id);
    }
    if ($order->status !== 'rejected') {
        $row1[] = $telegram->buildInlineKeyBoardButton("❌ رد", '', 'admin_order_reject_' . $order->id);
    }
    if (!empty($row1)) {
        $option[] = $row1;
    }

    // اضافه کردن دکمه ارسال بر اساس وضعیت فعلی
    if ($order->status !== 'sending') {
        $row2[] = $telegram->buildInlineKeyBoardButton("📤 ارسال شد", '', 'admin_order_send_' . $order->id);
    }

    // دکمه پیام به خریدار همیشه نمایش داده می‌شود
    $row2[] = $telegram->buildInlineKeyBoardButton("✉️ پیام به خریدار", '', 'admin_contact_buyer_' . $order->id);
    if (!empty($row2)) {
        $option[] = $row2;
    }

    $kb = $telegram->buildInlineKeyBoard($option);


    $receipt_path = $order_details->receipt_image_url;
    if ($receipt_path && file_exists($receipt_path)) {
        $content = [
            'chat_id' => $ADMIN_CHAT_ID,
            'photo' => new CURLFile(realpath($receipt_path)),
            'caption' => $text,
            'parse_mode' => 'HTML',
            'reply_markup' => $kb
        ];
        $telegram->sendPhoto($content);
    } else {
        sendMessage($ADMIN_CHAT_ID, $text, $kb);
    }
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

/* ---------- کمک‌توابع کیبورد ---------- */
function send_quick_admin_reply_keyboard($chat_id) {
    global $telegram;
    if (!method_exists($telegram, 'buildKeyBoard')) return;
    $rkey = $telegram->buildKeyBoard(
        [
            ['پنل ادمین 🏠'] 
        ],
        $onetime=false,
        $resize=true,
        $selective=false
    );
    sendMessage($chat_id,  "از منوی پایین برای دسترسی سریع استفاده کنید 👇", $rkey);
}

function build_back_to_admin_panel_inline()
{
    global $telegram;
    return $telegram->buildInlineKeyBoard([[$telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_root')]]);
}

/* --- بستن لودینگ کال‌بک برای UX بهتر --- */
if (isset($update['callback_query']['id']) && is_object($telegram) && method_exists($telegram, 'answerCallbackQuery')) {
    try {
        $telegram->answerCallbackQuery([
            'callback_query_id' => $update['callback_query']['id'],
            'text' => '👌',
            'show_alert' => false
        ]);
    } catch (\Throwable $e) { /* ignore */
    }
}

/* ======================================================================
   کمک‌تابع‌ها برای تشخیص نوع پیام (عکس/کپشن/voice/...) از $update
   ====================================================================== */
function extract_photo_from_update($update)
{
    if (!empty($update['message']['photo']) && is_array($update['message']['photo'])) {
        $photos = $update['message']['photo'];
        $largest = end($photos);
        return $largest['file_id'] ?? null;
    }
    return null;
}
function extract_caption_from_update($update)
{
    return $update['message']['caption'] ?? null;
}

/* ======================================================================
   منوی روت ادمین (Inline) — مستقل از admin_functions.php
   ====================================================================== */
function sendAdminRootMenu($chat_id, $mesasge_id = false)
{
    global $telegram;

    $kb = $telegram->buildInlineKeyBoard([
        [ $telegram->buildInlineKeyBoardButton("❓ مدیریت سوالات متداول", '', 'admin_manage_faqs') ],

        [
            $telegram->buildInlineKeyBoardButton("📊 آمار کلی", '', 'admin_stats'),
            $telegram->buildInlineKeyBoardButton("🧾 مدیریت سفارشات", '', 'admin_orders_paid')
        ],

        [
            $telegram->buildInlineKeyBoardButton("➕ افزودن محصول", '', 'admin_add_product'),
            $telegram->buildInlineKeyBoardButton("➕ افزودن دسته‌بندی", '', 'admin_add_category')
        ],

        [
            $telegram->buildInlineKeyBoardButton("✏️ مدیریت محصولات", '', 'admin_edit_product_all'),
            $telegram->buildInlineKeyBoardButton("📂 مدیریت دسته‌بندی‌ها", '', 'admin_manage_categories')
        ],

        // [ $telegram->buildInlineKeyBoardButton("👀 مشاهده ربات به عنوان کاربر", '', 'start') ],

        [
            $telegram->buildInlineKeyBoardButton("🗑️ حذف دسته بندی", '', 'admin_delete_category'),
            $telegram->buildInlineKeyBoardButton("🗑️ حذف محصول", '', 'admin_delete_product')
        ],

        [$telegram->buildInlineKeyBoardButton("⚙️ تنظیمات ربات", '', 'admin_settings_menu')],

    ]);

    // $kb = $telegram->buildInlineKeyBoard([
    //     [ $telegram->buildInlineKeyBoardButton("📊 آمار", '', 'admin_stats'),
    //       $telegram->buildInlineKeyBoardButton("➕ افزودن دسته‌بندی", '', 'admin_add_category') ],
    //     [ $telegram->buildInlineKeyBoardButton("➕ افزودن محصول", '', 'admin_add_product') ],
    //     [ $telegram->buildInlineKeyBoardButton("✏️ ویرایش محصول (همه)", '', 'admin_edit_product_all'),
    //       $telegram->buildInlineKeyBoardButton("🗑️ حذف محصول", '', 'admin_delete_product') ],
    //     [ $telegram->buildInlineKeyBoardButton("📂 مدیریت دسته‌بندی‌ها", '', 'admin_manage_categories') ],
    //     [ $telegram->buildInlineKeyBoardButton("🧾 سفارشات پرداخت‌شده", '', 'admin_orders_paid') ],
    //     [ $telegram->buildInlineKeyBoardButton("🏠 منوی اصلی", '', 'start') ],
    // ]);
    $txt = "🔐 <b>پنل مدیریت</b>\n\nیکی از گزینه‌ها را انتخاب کن:";
    sendMessage($chat_id, $txt, $kb, $mesasge_id);
}

// تابع جدید برای نمایش لیست سوالات متداول به ادمین
function listFaqsManage($chat_id, $mesasge_id=false) {
    global $telegram;
    $faqs = query("SELECT","faqs",false,false,true,"id DESC");

    $opt = [];
    $opt[] = [ $telegram->buildInlineKeyBoardButton("➕ افزودن سوال جدید", '', 'admin_add_faq') ];

    if ($faqs && count($faqs) > 0) {
        foreach ($faqs as $f){
            $status = ($f->status==='enable' ? '✅' : '⛔');
            $name = mb_substr($f->question, 0, 40) . '...';
            $opt[] = [
                $telegram->buildInlineKeyBoardButton($status." ".$name, '', 'noop'),
                $telegram->buildInlineKeyBoardButton(($f->status==='enable'?'غیرفعال‌سازی':'فعال‌سازی'), '', 'admin_toggle_faq_'.$f->id)
            ];
        }
    }

    $opt[] = [ $telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_root') ];
    $kb = $telegram->buildInlineKeyBoard($opt);
    sendMessage($chat_id, "❓ <b>مدیریت سوالات متداول</b>:", $kb, $mesasge_id);
}


/**
 * Displays a list of categories for the admin to choose for deletion.
 */
function sendAdminCategoryListToDelete($chat_id, $mesasge_id = false)
{
    global $telegram;

    // 1. Get all categories from the database
    $categories = query("SELECT", "categories", false, false, true, "id DESC");

    if (!$categories || count($categories) == 0) {
        $keyb = $telegram->buildInlineKeyBoard([[$telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_root')]]);
        return sendMessage($chat_id, "❌ هیچ دسته‌بندی برای حذف وجود ندارد.", $keyb, $mesasge_id);
    }

    $option = [];
    $text = "🗑️ **حذف دسته‌بندی**\n\nکدام دسته‌بندی را می‌خواهید حذف کنید؟\n\n";
    $text .= "⚠️ **توجه:** فقط دسته‌بندی‌هایی که هیچ محصولی ندارند قابل حذف هستند.\n\nپس توجه داشته باید اول محصولات دسته بندی رو پاک بفرمایید بعدا اقدام بفرمایید";

    // 2. Create a button for each category
    foreach ($categories as $cat) {
        $btn_text = ($cat->icon ?? '📂') . " " . $cat->name;
        // The callback will trigger a confirmation step
        $option[] = array($telegram->buildInlineKeyBoardButton($btn_text, '', 'admin_delete_category_select_' . $cat->id));
    }

    $option[] = array($telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_root'));

    $keyb = $telegram->buildInlineKeyBoard($option);
    sendMessage($chat_id, $text, $keyb, $mesasge_id);
}





/* ======================================================================
   لیست‌سازها داخل همین فایل (برای دور زدن محدودیت «فقط فعال‌ها»)
   ====================================================================== */
function listAllProductsForEdit($chat_id, $mesasge_id = false)
{
    global $telegram;
    $rows = query("SELECT", "products", false, false, true, "id DESC"); // همه، بدون فیلتر وضعیت
    if (!$rows || !count($rows)) {
        sendMessage($chat_id, "❌ محصولی وجود ندارد.", build_back_to_admin_panel_inline(), $mesasge_id);
        return;
    }
    $opt = [];
    foreach ($rows as $p) {
        $status = ($p->status === 'enable' ? '✅' : '⛔');
        $btn = $status . " " . mb_substr($p->title, 0, 32) . " (ID:" . $p->id . ")";
        $opt[] = [$telegram->buildInlineKeyBoardButton($btn, '', 'admin_edit_select_' . $p->id)];
    }
    $opt[] = [$telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_root')];
    $kb = $telegram->buildInlineKeyBoard($opt);
    sendMessage($chat_id, "✏️ <b>ویرایش محصول</b> — لیست همه‌ی محصولات:", $kb, $mesasge_id);
}

function listPaidOrders($chat_id, $mesasge_id = false)
{
    global $telegram, $conn;
    $sql = "SELECT id, user_id, user_chat_id, status, time FROM orders WHERE status  !='pending' ORDER BY id DESC LIMIT 100";
    $stm = $conn->query($sql);
    $rows = $stm ? $stm->fetchAll(PDO::FETCH_OBJ) : [];
    if (!$rows) {
        sendMessage($chat_id, "هیچ سفارش پرداخت‌شده‌ای پیدا نشد.", build_back_to_admin_panel_inline(), $mesasge_id);
        return;
    }
    $opt = [];
    foreach ($rows as $o) {
        // ✅✅✅ استفاده از توابع جدید برای فارسی‌سازی ✅✅✅
        $persian_status = translate_status_to_persian($o->status);
        $persian_date = format_persian_date($o->time);
        
        $cap = "🧾 " . ($o->trackId ?? "#" . $o->id) . " — {$persian_status} — {$persian_date}";
        $opt[] = [$telegram->buildInlineKeyBoardButton($cap, '', 'admin_order_view_' . $o->id)];
    }
    $opt[] = [$telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_root')];
    $kb = $telegram->buildInlineKeyBoard($opt);
    $text = "<b>لیست سفارشات اخیر</b> (حداکثر ۱۰۰ مورد اخیر):";

    // ✅ ۳. فقط یک بلاک برای ارسال پیام با منطق صحیح try/catch وجود دارد
    if ($mesasge_id) {
        try {
            $telegram->deleteMessage(['chat_id' => $chat_id, 'message_id' => $mesasge_id]);
        } catch (Exception $e) { /* نادیده گرفتن خطا */ }
    }
    
    // همیشه یک پیام جدید با لیست سفارشات ارسال می‌شود
    sendMessage($chat_id, $text, $kb);

}

function showOrderDetailsToAdmin($chat_id, $order_id, $mesasge_id = false)
{
    global $telegram, $conn;
    $order = query("SELECT", "orders", false, [["key" => "id", "condition" => "=", "value" => $order_id]]);
    if (!$order) {
        sendMessage($chat_id, "❌ سفارش یافت نشد.", build_back_to_admin_panel_inline(), $mesasge_id);
        return;
    }
    $details = query("SELECT", "order_details", false, [["key" => "order_id", "condition" => "=", "value" => $order_id]]);
    $sql = "SELECT quantity, price, product_title FROM orders_item WHERE order_id=:oid";
    $st = $conn->prepare($sql);
    $st->execute([':oid' => $order_id]);
    $items = $st->fetchAll(PDO::FETCH_OBJ);

    $txt = "🧾 <b>جزئیات سفارش</b> (" . ($order->trackId ?? "#" . $order->id) . ")\n";
    if ($details) {
        $txt .= "👤 {$details->first_name} {$details->last_name}\n📍 {$details->address}\n📞 {$details->phone_number}\n";
    }
    $txt .= "وضعیت فعلی: <b>{$order->status}</b>\n";
    $txt .= "──────────────\n<b>آیتم‌ها:</b>\n";
    $total = 0;
    foreach ($items as $it) {
        $line_total = $it->price * $it->quantity;
        $line = "• {$it->product_title} × {$it->quantity} = " . number_format($line_total) . " ت\n";
        $txt .= $line;
        $total += $line_total;
    }
    $txt .= "──────────────\n💰 جمع کل: <b>" . number_format($total) . " تومان</b>";

    $opt = [];
    // تایید/رد برای ادمین
    if ($order->status !== 'approved') {
        $opt[] = [$telegram->buildInlineKeyBoardButton("✅ تایید سفارش", '', 'admin_order_approve_' . $order->id)];
    }
    if ($order->status !== 'rejected') {
        $opt[] = [$telegram->buildInlineKeyBoardButton("❌ رد سفارش", '', 'admin_order_reject_' . $order->id)];
    }

    // ارسال به خریدار
    if ($order->status !== 'sending') {
        $opt[] = [$telegram->buildInlineKeyBoardButton("📤 ارسال محصول به مشتری", '', 'admin_order_send_' . $order->id)];
    }

    // پیام به خریدار (اگر chat_id داریم)
    $opt[] = [$telegram->buildInlineKeyBoardButton("✉️ پیام به خریدار", '', 'admin_contact_buyer_' . $order->id)];
    $opt[] = [$telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_orders_paid')];
    $kb = $telegram->buildInlineKeyBoard($opt);

    if ($mesasge_id) {
        try {
            $telegram->deleteMessage(['chat_id' => $chat_id, 'message_id' => $mesasge_id]);
        } catch (Exception $e) { /* نادیده گرفتن خطا */ }
    }

    $receipt_path = $details->receipt_image_url ?? null;

    if ($receipt_path && file_exists(realpath($receipt_path))) {
        // ارسال پیام جدید از نوع عکس
        $content = [
            'chat_id' => $chat_id, 'photo' => new CURLFile(realpath($receipt_path)),
            'caption' => $txt, 'parse_mode' => 'HTML', 'reply_markup' => $kb
        ];
        $telegram->sendPhoto($content);
    } else {
        // ارسال پیام جدید از نوع متن
        sendMessage($chat_id, $txt, $kb);
    }
}

function listCategoriesManage($chat_id, $mesasge_id = false)
{
    global $telegram;
    $cats = query("SELECT", "categories", false, false, true, "id DESC");
    if (!$cats || !count($cats)) {
        sendMessage($chat_id, "❌ دسته‌بندی‌ای وجود ندارد.", build_back_to_admin_panel_inline(), $mesasge_id);
        return;
    }
    $opt = [];
    foreach ($cats as $c) {
        $status = ($c->status === 'enable' ? '✅' : '⛔');
        $name = (($c->icon ?? '') ?: '📂') . ' ' . $c->name;
        $opt[] = [
            $telegram->buildInlineKeyBoardButton($status . " " . $name, '', 'noop'),
            $telegram->buildInlineKeyBoardButton(($c->status === 'enable' ? 'غیرفعال‌سازی ⛔' : 'فعال‌سازی ✅'), '', 'admin_toggle_category_' . $c->id)
        ];
    }
    $opt[] = [$telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_root')];
    $kb = $telegram->buildInlineKeyBoard($opt);
    sendMessage($chat_id, "📂 <b>مدیریت دسته‌بندی‌ها</b>:", $kb, $mesasge_id);
}

// admin_functions.php

function sendAdminSettingsMenu($chat_id, $mesasge_id = false)
{
    global $telegram;

    $kb = $telegram->buildInlineKeyBoard([
        [$telegram->buildInlineKeyBoardButton("📝 ویرایش متن راهنما", '', 'admin_edit_help')],
        [$telegram->buildInlineKeyBoardButton("🗣️ ویرایش متن پشتیبانی", '', 'admin_edit_support')],
        [$telegram->buildInlineKeyBoardButton("💳 ویرایش اطلاعات کارت", '', 'admin_edit_bank')],
        [$telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_root')],
    ]);

    $txt = "⚙️ **تنظیمات ربات**\n\nکدام بخش را می‌خواهید ویرایش کنید؟";
    sendMessage($chat_id, $txt, $kb, $mesasge_id);
}
