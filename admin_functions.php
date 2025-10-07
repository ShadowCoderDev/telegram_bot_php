<?php
// admin_functions.php
global $conn, $telegram, $resultTelegram, $chat_id, $mesasge_id;

/* =================== ADMIN FUNCTIONS =================== */

/**
 * نمایش منوی پنل مدیریت ادمین
 */
function sendAdminPanelMenu($chat_id, $mesasge_id = false) {
    global $telegram;
    $option = array(
        array($telegram->buildInlineKeyBoardButton("📊 آمار ربات", '', 'admin_stats')),
        array($telegram->buildInlineKeyBoardButton("➕ افزودن دسته‌بندی", '', 'admin_add_category'), $telegram->buildInlineKeyBoardButton("➕ افزودن محصول", '', 'admin_add_product')),
        array($telegram->buildInlineKeyBoardButton("✏️ ویرایش محصول", '', 'admin_edit_product'), $telegram->buildInlineKeyBoardButton("🗑️ حذف محصول", '', 'admin_delete_product')),
        array($telegram->buildInlineKeyBoardButton("🏠 منوی اصلی", '', 'start')),
    );
    $keyb = $telegram->buildInlineKeyBoard($option);
    $text = "🔐 <b>پنل مدیریت</b>\n\n";
    $text .= "خوش آمدید ادمین! 👋\n";
    $text .= "یکی از گزینه‌های زیر را انتخاب کنید:\n";
    sendMessage($chat_id, $text, $keyb, $mesasge_id);
}

/**
 * نمایش لیست محصولات برای ویرایش یا حذف
 * نکته: برای حذف اول صفحه‌ی تایید می‌آوریم => callback 'admin_delete_select_{id}'
 */
function sendAdminProductList($chat_id, $action, $mesasge_id = false) {
    global $telegram;
    
    $products = query("SELECT", "products", false, [["key" => "status", "condition" => "=", "value" => "enable"]], true, "id DESC");
    
    if (!$products || count($products) == 0) {
        $keyb = $telegram->buildInlineKeyBoard([[ $telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_panel') ]]);
        return sendMessage($chat_id, "❌ محصول موجود نیست.", $keyb, $mesasge_id);
    }
    
    $option = [];
    $callback_prefix = ($action == 'edit_product') ? 'admin_edit_select_' : 'admin_delete_select_'; // ✅ اصلاح شد
    $title_action = ($action == 'edit_product') ? '✏️ ویرایش' : '🗑️ حذف';
    
    foreach ($products as $product) {
        $btn_text = "• " . substr($product->title, 0, 30) . " (" . number_format($product->price) . " ت)";
        $option[] = array($telegram->buildInlineKeyBoardButton($btn_text, '', $callback_prefix . $product->id));
    }
    
    $option[] = array($telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_panel'));
    
    $keyb = $telegram->buildInlineKeyBoard($option);
    $text = $title_action . " - <b>لطفاً محصول را انتخاب کنید:</b>\n\n";
    $text .= "تعداد محصولات: <b>" . count($products) . "</b>";
    
    sendMessage($chat_id, $text, $keyb, $mesasge_id);
}

/**
 * نمایش اطلاعات محصول جهت مشاهده/ویرایش یا تایید حذف
 * دکمه «✏️ ویرایش این محصول» اضافه شد که منوی ویرایش را باز می‌کند.
 */
function showProductInfo($chat_id, $product_id, $action = 'view', $mesasge_id = false) {
    global $telegram;
    
    $product = query("SELECT", "products", false, [["key" => "id", "condition" => "=", "value" => $product_id]]);
    
    if (!$product) {
        $keyb = $telegram->buildInlineKeyBoard([[ $telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_panel') ]]);
        return sendMessage($chat_id, "❌ محصول یافت نشد.", $keyb, $mesasge_id);
    }
    
    $status_txt = ($product->status == 'enable' ? '✅ فعال' : '❌ غیرفعال');
    $text  = "<b>📦 اطلاعات محصول #{$product->id}:</b>\n\n";
    $text .= "<b>نام:</b> {$product->title}\n";
    $text .= "<b>توضیحات:</b> " . substr($product->description, 0, 120) . "...\n";
    $text .= "<b>قیمت:</b> " . number_format((int)$product->price) . " تومان\n";
    $text .= "<b>نویسنده/مدرس:</b> {$product->author}\n";
    $text .= "<b>تصویر:</b> {$product->image_url}\n";
    $text .= "<b>دسته:</b> {$product->category_id}\n";
    $text .= "<b>موجودی:</b> " . ((int)($product->inventory ?? 0)) . "\n";
    $text .= "<b>وضعیت:</b> {$status_txt}\n";
    
    if ($action == 'delete') {
        $text .= "\n⚠️ <b>آیا از حذف این محصول اطمینان دارید؟</b>";
        $option = array(
            array($telegram->buildInlineKeyBoardButton("✅ بله، حذف کن", '', 'admin_delete_confirm_' . $product->id), $telegram->buildInlineKeyBoardButton("❌ خیر، منصرف شدم", '', 'admin_panel')),
        );
    } else {
        $option = array(
            array($telegram->buildInlineKeyBoardButton("✏️ ویرایش این محصول", '', 'admin_edit_menu_' . $product->id)),
            array($telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_panel')),
        );
    }
    
    $keyb = $telegram->buildInlineKeyBoard($option);
    sendMessage($chat_id, $text, $keyb, $mesasge_id);
}

/**
 * نمایش کلیه دسته‌بندی‌ها
 */
function showAllCategories($chat_id, $mesasge_id = false) {
    global $telegram, $conn;
    
    $categories = query("SELECT", "categories", false, [["key" => "status", "condition" => "=", "value" => "enable"]], true);
    
    $text = "📂 <b>دسته‌بندی‌های موجود:</b>\n\n";
    
    if (!$categories || count($categories) == 0) {
        $text .= "❌ هیچ دسته‌بندی موجود نیست.";
    } else {
        foreach ($categories as $cat) {
            $products_count = $conn->query("SELECT count(*) FROM products WHERE category_id = " . intval($cat->id) . " AND status = 'enable'")->fetchColumn();
            $text .= "{$cat->icon} <b>{$cat->name}</b> ({$products_count} محصول)\n";
        }
    }
    
    $keyb = $telegram->buildInlineKeyBoard([[ $telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_panel') ]]);
    sendMessage($chat_id, $text, $keyb, $mesasge_id);
}

/**
 * دریافت آمار دقیق‌تر برای ادمین
 */
function getDetailedStats() {
    global $conn;
    
    $stats = [];
    $stats['users'] = $conn->query("SELECT count(*) FROM users")->fetchColumn();
    $stats['products'] = $conn->query("SELECT count(*) FROM products WHERE status = 'enable'")->fetchColumn();
    $stats['categories'] = $conn->query("SELECT count(*) FROM categories WHERE status = 'enable'")->fetchColumn();
    $stats['pending_orders'] = $conn->query("SELECT count(*) FROM orders WHERE status = 'pending'")->fetchColumn();
    $stats['completed_orders'] = $conn->query("SELECT count(*) FROM orders WHERE status = 'payed'")->fetchColumn();
    $stats['total_revenue'] = $conn->query("SELECT COALESCE(SUM(total_price), 0) FROM orders WHERE status = 'payed'")->fetchColumn() ?: 0;
    
    return $stats;
}

/**
 * صدور گزارش محصولات برای ادمین
 */
function generateProductReport($chat_id, $mesasge_id = false) {
    global $conn, $telegram;
    
    $products = query("SELECT", "products", false, [["key" => "status", "condition" => "=", "value" => "enable"]], true, "price DESC");
    
    $text = "📊 <b>گزارش محصولات</b>\n\n";
    $text .= "<b>کل محصولات: " . count($products) . "</b>\n\n";
    
    if (count($products) > 0) {
        foreach ($products as $product) {
            $sales = $conn->query("SELECT COALESCE(SUM(quantity), 0) as total FROM orders_item WHERE product_id = " . intval($product->id))->fetch(PDO::FETCH_OBJ);
            $sold_count = $sales->total ?? 0;
            $text .= "<b>📦 " . substr($product->title, 0, 25) . "</b>\n";
            $text .= "💲 قیمت: " . number_format($product->price) . " تومان\n";
            $text .= "📈 فروخته شده: {$sold_count} عدد\n";
            $text .= "─────────────────\n";
        }
    }
    
    $keyb = $telegram->buildInlineKeyBoard([[ $telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_panel') ]]);
    sendMessage($chat_id, $text, $keyb, $mesasge_id);
}

/**
 * اطلاع‌رسانی ادمین از سفارش جدید (در صورت نیاز)
 */
function notifyAdminOfNewOrder($order_id) {
    global $telegram, $conn, $ADMIN_CHAT_ID;

    $order = query("SELECT", "orders", false, [["key"=>"id","condition"=>"=","value"=>$order_id]]);
    $order_details = query("SELECT", "order_details", false, [["key"=>"order_id","condition"=>"=","value"=>$order_id]]);
    if (!$order || !$order_details) return;

    $text = "🔔 <b>سفارش جدید ثبت شد!</b> 🔔\n\n";
    $text .= "<b>شماره سفارش:</b> #{$order->id}\n";
    $text .= "<b>نام مشتری:</b> {$order_details->first_name} {$order_details->last_name}\n";
    $text .= "<b>آدرس:</b> {$order_details->address}\n";
    $text .= "<b>تلفن:</b> {$order_details->phone_number}\n";
    $text .= "─────────────────\n<b>محصولات سفارش:</b>\n\n";

    $sql = "SELECT oi.quantity, p.title, p.price FROM `orders_item` oi JOIN `products` p ON oi.product_id = p.id WHERE oi.order_id=:oid";
    $stmt = $conn->prepare($sql);
    $stmt->bindValue(':oid', $order_id, PDO::PARAM_INT);
    $stmt->execute();
    $items = $stmt->fetchAll(PDO::FETCH_OBJ);

    $total_price = 0;
    foreach ($items as $item) {
        $text .= "📦 {$item->title} (<b>{$item->quantity} عدد</b>)\n";
        $total_price += $item->quantity * $item->price;
    }

    $text .= "─────────────────\n";
    $text .= "💰 <b>جمع کل فاکتور:</b> " . number_format($total_price) . " تومان\n";

    // دکمه پیام به خریدار
    global $telegram;
    $kb = $telegram->buildInlineKeyBoard([
        [ $telegram->buildInlineKeyBoardButton("✉️ پیام به خریدار", '', 'admin_contact_buyer_' . (int)$order_id) ]
    ]);

    $receipt_path = $order_details->receipt_image_url;
    if ($receipt_path && file_exists($receipt_path)) {
        $content = [
            'chat_id' => $ADMIN_CHAT_ID,
            'photo'   => new CURLFile(realpath($receipt_path)),
            'caption' => $text,
            'parse_mode' => 'HTML',
            'reply_markup' => $kb
        ];
        $telegram->sendPhoto($content);
    } else {
        sendMessage($ADMIN_CHAT_ID, $text, $kb);
    }
}
