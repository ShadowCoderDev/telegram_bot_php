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
        array($telegram->buildInlineKeyBoardButton("سوالات متداول ❓", '', 'show_faqs')),
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

        // if ($order_by) $sql .= (" ORDER BY " . $order_by); --- IGNORE ---
        if ($order_by) {
            // لیست ستون‌ها و جهت‌های مجاز برای مرتب‌سازی
            $allowed_order_by = [
                'id DESC',
                'id ASC',
                'price DESC',
                'price ASC'
                // هر ستون دیگه‌ای که لازم داری اضافه کن
            ];
            if (in_array($order_by, $allowed_order_by)) {
                $sql .= " ORDER BY " . $order_by;
            }
        }



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




/**
 * Generates a unique tracking ID for an order.
 * It ensures the generated ID does not already exist in the orders table.
 * @param int $length The length of the random part of the ID.
 * @return string The unique tracking ID.
 */
function generateTrackId($length = 5) {
    global $conn; // Access the database connection

    $prefix = "IELTS-"; 
    
    do {
        $characters = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        $randomPart = '';
        for ($i = 0; $i < $length; $i++) {
            $randomPart .= $characters[rand(0, strlen($characters) - 1)];
        }
        $newTrackId = $prefix . $randomPart;

        // Check for uniqueness in the database
        $stmt = $conn->prepare("SELECT id FROM orders WHERE trackId = :track_id");
        $stmt->execute([':track_id' => $newTrackId]);
        $exists = $stmt->fetch();

    } while ($exists); // Keep looping until a unique ID is found

    return $newTrackId;
}

/**
 * Snapshots the current product details (price, title) into the order_item table.
 * This locks the order details at the moment of payment.
 * @param int $order_id The ID of the order to snapshot.
 */
function snapshotOrderDetails($order_id) {
    global $conn;
    // این کوئری با یک حرکت تمام آیتم‌های سفارش را آپدیت می‌کند
    $sql = "UPDATE orders_item oi
            JOIN products p ON oi.product_id = p.id
            SET
                oi.price = p.price,
                oi.product_title = p.title
            WHERE oi.order_id = :order_id AND oi.price IS NULL";
    $stmt = $conn->prepare($sql);
    $stmt->execute([':order_id' => $order_id]);
}

// functions.php

/**
 * Translates order status from English to Persian.
 * @param string $status The English status.
 * @return string The Persian status.
 */
function translate_status_to_persian($status) {
    $map = [
        'pending'   => 'در انتظار پرداخت',
        'payed'     => 'پرداخت شده',
        'approved'  => 'تایید شده',
        'rejected'  => 'رد شده',
        'cancel'    => 'لغو شده',
        'sending'   => 'ارسال شده',
    ];
    return $map[$status] ?? $status; // اگر ترجمه موجود نبود، خود کلمه انگلیسی را برمی‌گرداند
}

/**
 * Converts a Unix timestamp to a full Persian (Jalali) date and time string with Persian digits.
 * @param int $timestamp The Unix timestamp.
 * @return string The formatted Persian date and time.
 */
function format_persian_date($timestamp) {
    // ابتدا ساعت و دقیقه را با توجه به timezone صحیح ایران استخراج می‌کنیم
    $time_str = date('H:i', $timestamp);
    
    // الگوریتم دقیق تبدیل تاریخ میلادی به شمسی (جلالی)
    list($g_y, $g_m, $g_d) = explode('-', date('Y-m-d', $timestamp));
    $g_days_in_month = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    $j_days_in_month = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, 29];

    $gy = $g_y - 1600;
    $gm = $g_m - 1;
    $gd = $g_d - 1;

    $g_day_no = 365 * $gy + floor(($gy + 3) / 4) - floor(($gy + 99) / 100) + floor(($gy + 399) / 400);

    for ($i = 0; $i < $gm; ++$i)
        $g_day_no += $g_days_in_month[$i];
    if ($gm > 1 && (($gy % 4 == 0 && $gy % 100 != 0) || ($gy % 400 == 0)))
        $g_day_no++;
    $g_day_no += $gd;

    $j_day_no = $g_day_no - 79;

    $j_np = floor($j_day_no / 12053);
    $j_day_no = $j_day_no % 12053;

    $jy = 979 + 33 * $j_np + 4 * floor($j_day_no / 1461);
    $j_day_no %= 1461;

    if ($j_day_no >= 366) {
        $jy += floor(($j_day_no - 1) / 365);
        $j_day_no = ($j_day_no - 1) % 365;
    }

    for ($i = 0; $i < 11 && $j_day_no >= $j_days_in_month[$i]; ++$i)
        $j_day_no -= $j_days_in_month[$i];
    $jm = $i + 1;
    $jd = $j_day_no + 1;

    $jalali_date_str = sprintf('%04d/%02d/%02d', $jy, $jm, $jd) . " - " . $time_str;

    // تبدیل اعداد به فارسی
    $persian_digits = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
    $english_digits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
    return str_replace($english_digits, $persian_digits, $jalali_date_str);
}




/**
 * نمایش لیست سفارشات کاربر (نسخه جدید و بهینه)
 */
function renderMyOrders($chat_id, $mesasge_id = false) {
        global $telegram, $conn;
        $user_detail = query("SELECT", "users", false, [["key" => "chat_id", "condition" => "=", "value" => $chat_id]]);

        // مرحله ۱: دریافت اطلاعات کلی ۵ سفارش آخر
        $sql_orders = "
            SELECT
                o.id, o.status, o.trackId,
                od.first_name, od.last_name, od.address, od.phone_number,
                SUM(oi.price * oi.quantity) as total_price
            FROM orders AS o
            LEFT JOIN orders_item AS oi ON o.id = oi.order_id
            LEFT JOIN order_details AS od ON o.id = od.order_id
            WHERE o.user_id = :user_id AND o.status != 'pending'
            GROUP BY o.id, o.status, o.trackId, od.first_name, od.last_name, od.address, od.phone_number
            ORDER BY o.id DESC
            LIMIT 5
        ";
        $stmt_orders = $conn->prepare($sql_orders);
        $stmt_orders->execute([':user_id' => $user_detail->id]);
        $orders_with_details = $stmt_orders->fetchAll(PDO::FETCH_OBJ);

        if (!$orders_with_details || count($orders_with_details) == 0) {
            $text = "📑 <b>سفارشات شما</b>\n\nهنوز سفارش تکمیل‌شده‌ای ندارید.";
            $keyb = $telegram->buildInlineKeyBoard([[$telegram->buildInlineKeyBoardButton("بازگشت 🏠", '', 'start')]]);
            sendMessage($chat_id, $text, $keyb, $mesasge_id);
        } else {
            // مرحله ۲: دریافت تمام آیتم‌های مربوط به سفارشات بالا
            $order_ids = array_map(function ($order) {
                return $order->id;
            }, $orders_with_details);

            $items_by_order_id = [];
            if (!empty($order_ids)) {
                $in_placeholders = implode(',', array_fill(0, count($order_ids), '?'));

                $sql_items = "SELECT order_id, product_title, quantity, price FROM orders_item WHERE order_id IN ($in_placeholders)";
                $stmt_items = $conn->prepare($sql_items);
                $stmt_items->execute($order_ids);
                $all_items = $stmt_items->fetchAll(PDO::FETCH_OBJ);

                foreach ($all_items as $item) {
                    $items_by_order_id[$item->order_id][] = $item;
                }
            }

            // مرحله ۳: نمایش اطلاعات کامل به کاربر
            $text = "📑 <b>5 سفارش آخر شما:</b>\n\n";
            foreach ($orders_with_details as $order) {
                $status_text = 'نامشخص';
                if ($order->status == 'payed')
                    $status_text = '✅ پرداخت شده - در انتظار تایید';
                if ($order->status == 'rejected')
                    $status_text = '❌ رد شده';
                if ($order->status == 'cancel')
                    $status_text = '🚫 لغو شده';
                if ($order->status == 'approved')
                    $status_text = '✔️ تایید شده';
                if ($order->status == 'sending')
                    $status_text = '📤 در حال ارسال';

                $text .= "🆔 <b>کد رهگیری: {$order->trackId}</b>\n";
                if ($order->first_name) {
                    $text .= "👤 " . $order->first_name . " " . $order->last_name . "\n";
                    // ✅✅✅ این دو خط دوباره اضافه شدند ✅✅✅
                    $text .= "📍 آدرس: " . htmlspecialchars($order->address) . "\n";
                    $text .= "📱 تلفن: " . htmlspecialchars($order->phone_number) . "\n";
                }

                $text .= "<b>محصولات خریداری شده:</b>\n";
                if (!empty($items_by_order_id[$order->id])) {
                    foreach ($items_by_order_id[$order->id] as $order_item) {
                        $item_line = "   • <i>" . htmlspecialchars($order_item->product_title) . "</i> (تعداد: {$order_item->quantity} - قیمت فی: " . number_format($order_item->price) . " تومان)\n";
                        $text .= $item_line;
                    }
                }

                $total_price = $order->total_price ?? 0;
                $text .= "💵 <b>جمع کل:</b> " . number_format($total_price) . " تومان\n";
                $text .= "📌 <b>وضعیت:</b> " . $status_text . "\n";
                $text .= "────\n\n";
            }
            $keyb = $telegram->buildInlineKeyBoard([[$telegram->buildInlineKeyBoardButton("بازگشت 🏠", '', 'start')]]);
            sendMessage($chat_id, $text, $keyb, $mesasge_id);
        }
        exit;
}

/**
 * نمایش لیست سوالات متداول (FAQ)
 */
function renderFAQs($chat_id, $mesasge_id = false) {
    global $telegram;
    $faqs = query("SELECT", "faqs", false, [["key"=>"status","condition"=>"=","value"=>"enable"]], true, "id ASC");

    if (!$faqs || count($faqs) == 0) {
        $text = "❓ بخشی برای سوالات متداول تعریف نشده است.";
        $keyb = $telegram->buildInlineKeyBoard([[ $telegram->buildInlineKeyBoardButton("بازگشت 🏠", '', 'start') ]]);
    } else {
        $text = "❓ <b>سوالات متداول</b>\n\nلطفاً سوال خود را از لیست زیر انتخاب کنید تا پاسخ آن نمایش داده شود:\n\n";
        $option = [];
        foreach ($faqs as $faq) {
            $option[] = array($telegram->buildInlineKeyBoardButton("▫️ " . $faq->question, '', 'faq_answer_' . $faq->id));
        }
        $option[] = array($telegram->buildInlineKeyBoardButton("بازگشت 🏠", '', 'start'));
        $keyb = $telegram->buildInlineKeyBoard($option);
    }
    sendMessage($chat_id, $text, $keyb, $mesasge_id);
}

/**
 * نمایش راهنمای ربات (نسخه داینامیک)
 */
function renderHelp($chat_id, $mesasge_id = false) {
    global $telegram;
    $help_setting = query("SELECT", "settings", false, [["key"=>"setting_key","condition"=>"=","value"=>"help_text"]]);
    $help_text = $help_setting ? $help_setting->setting_value : "راهنما هنوز تنظیم نشده است.";
    
    $text = "❓ <b>راهنمای ربات</b>\n\n" . $help_text;
    $keyb = $telegram->buildInlineKeyBoard([[ $telegram->buildInlineKeyBoardButton("بازگشت 🏠", '', 'start') ]]);
    sendMessage($chat_id, $text, $keyb, $mesasge_id);
}


/**
 * نمایش اطلاعات پشتیبانی
 */
function renderSupport($chat_id, $mesasge_id = false) {
    global $telegram;
    
    // خواندن آیدی پشتیبانی از دیتابیس
    $setting = query("SELECT", "settings", false, [["key"=>"setting_key","condition"=>"=","value"=>"support"]]);
    
    $support_id = $setting ? $setting->setting_value : "پشتیبانی تنظیم نشده"; // یک مقدار پیش‌فرض

    $text = "🗣️ <b>تماس با پشتیبانی</b>\n\n";
    $text .= "شما می‌توانید سوالات، مشکلات و پیشنهادات خود را از طریق آیدی تلگرام زیر با ما در میان بگذارید:\n\n";
    $text .= "<b>" . $support_id . "</b>";

    $keyb = $telegram->buildInlineKeyBoard([[ $telegram->buildInlineKeyBoardButton("بازگشت 🏠", '', 'start') ]]);
    
    sendMessage($chat_id, $text, $keyb, $mesasge_id);
}




function sendUserPersistentKeyboard($chat_id) {
    global $telegram;
    $option = [
        ['🛍️ خرید محصول'],
        ['🛒 سبد خرید', '✉️ سفارشات من'],
        // دکمه راهنما به سوالات متداول تغییر کرد
        ['🗣️ پشتیبانی', '❓ سوالات متداول']
    ];
    $keyb = $telegram->buildKeyBoard($option, $onetime = false, $resize = true);
    sendMessage($chat_id,  "از منوی پایین برای دسترسی سریع استفاده کنید 👇", $keyb);
}



