<?php
// functions.php
global $conn, $telegram, $resultTelegram, $chat_id, $mesasge_id;

// تشخیص file_id تصویر از پیام (photo یا document با MIME تصویری)
function extractImageFileIdFromMessage($update) {
    // photo (آلبوم از کوچک تا بزرگ؛ آخرین آیتم بزرگتره)
    if (isset($update['message']['photo']) && is_array($update['message']['photo']) && count($update['message']['photo']) > 0) {
        $arr = $update['message']['photo'];
        return $arr[count($arr)-1]['file_id'] ?? null;
    }

    // document (اگر تصویر باشه)
    if (isset($update['message']['document'])) {
        $doc = $update['message']['document'];
        $mime = $doc['mime_type'] ?? '';
        if (strpos($mime, 'image/') === 0) {
            return $doc['file_id'] ?? null;
        }
    }

    return null; // نه photo بود نه document تصویری
}

// دانلود فایل تلگرام با file_id
function downloadTelegramFileById($file_id, $save_dir = 'uploads') {
    if (!$file_id) return [false, "file_id خالی است."];

    global $telegram;
    // گرفتن مسیر فایل
    $file = $telegram->getFile($file_id);
    // بعضی لایبرری‌ها آبجکت برمی‌گردونن، بعضی آرایه
    $file_path = null;
    if (is_array($file)) {
        // اگر ساختار شبیه پاسخ رسمی تلگرام باشه
        $file_path = $file['result']['file_path'] ?? ($file['file_path'] ?? null);
    } else if (is_object($file)) {
        $file_path = $file->file_path ?? null;
    }

    if (!$file_path) {
        return [false, "file_path از تلگرام دریافت نشد."];
    }

    // ساخت آدرس دانلود
    $url = botFileURL($file_path);

    // ساخت مسیر ذخیره
    if (!is_dir($save_dir)) {
        @mkdir($save_dir, 0775, true);
    }
    $ext = pathinfo($file_path, PATHINFO_EXTENSION);
    if (!$ext) $ext = 'jpg';
    $name = 'receipt_' . date('Ymd_His') . '_' . mt_rand(1000,9999) . '.' . $ext;
    $dest = rtrim($save_dir, '/').'/'.$name;

    // دانلود
    $data = @file_get_contents($url);
    if ($data === false || strlen($data) === 0) {
        return [false, "دانلود فایل از تلگرام ناموفق بود."];
    }
    if (@file_put_contents($dest, $data) === false) {
        return [false, "ذخیره‌سازی فایل روی سرور ناموفق بود."];
    }

    return [true, $dest];
}



function sendMessage($chat_id, $text, $keyboard = false, $editMessage = false) {
    global $telegram;
    $content = array('chat_id' => $chat_id, 'text' => $text, 'parse_mode' => 'HTML');
    if ($keyboard) $content["reply_markup"] = $keyboard;
    if ($editMessage) {
        $content['message_id'] = $editMessage;
        return $telegram->editMessageText($content);
    }
    return $telegram->sendMessage($content);
}
function sendPhoto($chat_id, $photo_url, $caption, $keyboard = false) {
    global $telegram;
    $content = array('chat_id' => $chat_id, 'photo' => $photo_url, 'caption' => $caption, 'parse_mode' => 'HTML');
    if ($keyboard) $content["reply_markup"] = $keyboard;
    return $telegram->sendPhoto($content);
}
function botFileURL($file_path) {
    global $BOT_TOKEN;
    return 'https://api.telegram.org/file/bot' . $BOT_TOKEN . '/' . $file_path;
}
function sendMainKeyboardMenu($chat_id, $mesasge_id = false) {
    global $telegram;
    $option = array(
        array($telegram->buildInlineKeyBoardButton("خریــــد محصول 🛍️", '', 'buy_product')),
        array($telegram->buildInlineKeyBoardButton("سبد خرید 🛒", '', 'view_cart'), $telegram->buildInlineKeyBoardButton("سفارشات من ✉️", '', 'my_orders')),
        array($telegram->buildInlineKeyBoardButton("راهنما ❓", '', 'help'), $telegram->buildInlineKeyBoardButton("پشتیبانی 🗣️", '', 'support')),
    );
    $keyb = $telegram->buildInlineKeyBoard($option);
    $text = "سلام <b>" . $telegram->FirstName() . "</b>\n";
    $text .= "به فروشگاه آنلاین مدرس انگلیسی خوش آمدید ❤️\n\n";
    $text .= "⭐️ دروه های آنلاین و کتاب های تخصصی آیلتس\n";
    sendMessage($chat_id, $text, $keyb, $mesasge_id);
}

/* ============== Helper Query (CRUD ساده با PDO) ============== */
function query($action, $table, $fields = false, $wheres = false, $isfetchall = false, $order_by = false) {
    global $conn;

    if ($action == "CREATE") {
        $values = [];
        $sql = "INSERT INTO $table SET ";
        $item = 1;
        foreach ($fields as $key => $value) {
            $sql .= ($key . '=? ');
            $values[] = $value;
            if ($item < count($fields)) $sql .= ', ';
            $item++;
        }
        $statment = $conn->prepare($sql);
        foreach ($values as $i => $v) $statment->bindValue($i + 1, $v);
        $statment->execute();
        return $conn->lastInsertId();
    }

    if ($action == "UPDATE") {
        $values = [];
        $sql = "UPDATE $table SET ";
        $item = 1;
        foreach ($fields as $key => $value) {
            $sql .= ($key . '=? ');
            $values[] = $value;
            if ($item < count($fields)) $sql .= ', ';
            $item++;
        }
        if ($wheres) {
            $sql .= "WHERE ";
            $item = 1;
            foreach ($wheres as $where) {
                $sql .= $where["key"] . $where["condition"] . "?";
                $values[] = $where["value"];
                if ($item < count($wheres)) $sql .= ' AND ';
                $item++;
            }
        }
        $statment = $conn->prepare($sql);
        foreach ($values as $i => $v) $statment->bindValue($i + 1, $v);
        $statment->execute();
        return true;
    }

    if ($action == "SELECT") {
        $values = [];
        $sql = "SELECT * FROM $table ";
        if ($wheres) {
            $sql .= "WHERE ";
            $item = 1;
            foreach ($wheres as $where) {
                $sql .= $where["key"] . $where["condition"] . "?";
                $values[] = $where["value"];
                if ($item < count($wheres)) $sql .= ' AND ';
                $item++;
            }
        }
        if ($order_by) $sql .= (" ORDER BY " . $order_by);
        $statment = $conn->prepare($sql);
        foreach ($values as $i => $v) $statment->bindValue($i + 1, $v);
        $statment->execute();
        if ($isfetchall) return $statment->fetchAll(PDO::FETCH_OBJ);
        return $statment->fetch(PDO::FETCH_OBJ);
    }
    return null;
}

/* ============== کارت محصول با دکمه‌های qty و افزودن ============== */
/* ============== کارت محصول با دکمه‌های qty و افزودن (نسخه اصلاح شده) ============== */
function renderProductCard($chat_id, $product_id, $qty = 1, $mesasge_id = false) {
    global $telegram;

    $qty = max(1, min(99, intval($qty)));
    $product = query("SELECT", "products", false, [["key"=>"id","condition"=>"=","value"=>$product_id]]);
    if (!$product) {
        // اگر محصولی پیدا نشد، به جای خطا یک پیام مناسب به کاربر بده
        $keyb = $telegram->buildInlineKeyBoard([
            [ $telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'buy_product') ]
        ]);
        return sendMessage($chat_id, "❌ محصول مورد نظر یافت نشد یا حذف شده است.", $keyb, $mesasge_id);
    }

    // ۱. همیشه لینک عکس را به متن اضافه می‌کنیم (اگر وجود داشته باشد)
    $text = "";
    if (!empty($product->image_url)) {
        // این ترفند باعث نمایش عکس در بالای متن می‌شود
        $text .= "<a href='" . $product->image_url . "'>&#8203;</a>";
    }

    $text .= "<b>▫️ محصول:</b> ✨ " . $product->title . " ✨\n\n";
    $text .= "<b>💸 مبلغ واحد:</b> " . number_format($product->price) . " تومان\n";
    $text .= "<b>🔢 تعداد انتخابی:</b> " . $qty . "\n";
    $text .= "<b>💰 مبلغ این آیتم:</b> " . number_format($product->price * $qty) . " تومان\n\n";
    $text .= "<b>▫️ توضیحات:</b>\n" . $product->description . "\n";
    if (!empty($product->author)) $text .= "\n<b>✍️ نویسنده/مدرس:</b> " . $product->author . "\n";

    $option = array(
        array(
            $telegram->buildInlineKeyBoardButton("➖", '', 'qty_minus_' . $product->id . '_' . $qty),
            $telegram->buildInlineKeyBoardButton((string)$qty, '', 'noop'),
            $telegram->buildInlineKeyBoardButton("➕", '', 'qty_plus_' . $product->id . '_' . $qty)
        ),
        array($telegram->buildInlineKeyBoardButton("افزودن به سبد خرید ✅", '', 'add_to_cart_' . $product->id . '_' . $qty)),
        array($telegram->buildInlineKeyBoardButton("بازگشت به لیست 🔙", '', 'category_' . $product->category_id)),
    );
    $keyb = $telegram->buildInlineKeyBoard($option);

    // ۲. شرط if ($mesasge_id) و تابع sendPhoto حذف شد
    // ۳. همیشه از sendMessage برای ویرایش پیام استفاده می‌کنیم
    return sendMessage($chat_id, $text, $keyb, $mesasge_id);
}
/* ============== رندر سبد خرید ============== */
function renderCart($chat_id, $mesasge_id = false) {
    global $telegram, $conn;
    $user_detail = query("SELECT", "users", false, [["key"=>"chat_id","condition"=>"=","value"=>$chat_id]]);
    if (!$user_detail) {
        $keyb = $telegram->buildInlineKeyBoard([[ $telegram->buildInlineKeyBoardButton("بازگشت 🏠", '', 'start') ]]);
        return sendMessage($chat_id, "📪 سبد خرید شما خالی هست", $keyb, $mesasge_id);
    }

    $active_order = query("SELECT", "orders", false, [
        ["key"=>"status","condition"=>"=","value"=>"pending"],
        ["key"=>"user_id","condition"=>"=","value"=>$user_detail->id]
    ]);
    if (!$active_order) {
        $keyb = $telegram->buildInlineKeyBoard([[ $telegram->buildInlineKeyBoardButton("بازگشت 🏠", '', 'start') ]]);
        return sendMessage($chat_id, "📪 سبد خرید شما خالی هست", $keyb, $mesasge_id);
    }

    $sql = "SELECT orders_item.id AS orderitem_id, orders_item.quantity,
                   products.id as product_id, products.title as product_title, products.price as product_price
            FROM `orders_item`
            LEFT JOIN products ON orders_item.product_id = products.id
            WHERE orders_item.order_id=:oid";
    $stmt = $conn->prepare($sql);
    $stmt->bindValue(':oid', $active_order->id, PDO::PARAM_INT);
    $stmt->execute();
    $products = $stmt->fetchAll(PDO::FETCH_OBJ);

    if (!$products || count($products) == 0) {
        $keyb = $telegram->buildInlineKeyBoard([[ $telegram->buildInlineKeyBoardButton("بازگشت 🏠", '', 'start') ]]);
        return sendMessage($chat_id, "📪 سبد خرید شما خالی هست", $keyb, $mesasge_id);
    }

    $text = "<b>🛒 سبد خرید شما:</b>\n\n";
    $total_price = 0;
    foreach ($products as $p) {
        $item_total = intval($p->product_price) * intval($p->quantity);
        $total_price += $item_total;
        $text .= "📦 <b>{$p->product_title}</b>\n";
        $text .= "🔢 تعداد: {$p->quantity}\n";
        $text .= "💵 قیمت: " . number_format($item_total) . " تومان\n";
        $text .= "🗑️ حذف: /delete_item_{$p->orderitem_id}\n";
        $text .= "─────────────────\n";
    }
    $text .= "\n✅ <b>جمع کل:</b> " . number_format($total_price) . " تومان\n";

    $option = array(
        array($telegram->buildInlineKeyBoardButton("تکمیل خرید 💳", '', 'checkout')),
        array($telegram->buildInlineKeyBoardButton("حذف سبد خرید ❌", '', 'clear_cart'), $telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'start')),
    );
    $keyb = $telegram->buildInlineKeyBoard($option);
    return sendMessage($chat_id, $text, $keyb, $mesasge_id);
}



