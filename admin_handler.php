<?php
// admin_handler.php
global $conn, $telegram, $resultTelegram, $chat_id, $mesasge_id;


$callback_data = $resultTelegram['callback_query']['data'] ?? null;
$text_message = $telegram->Text();

// --- پردازش پیام‌های متنی (دستور لغو و ورود در اولویت) ---
if ($text_message) {
    if ($text_message == '/cancel') {
        $conn->query("DELETE FROM `admin_process_state` WHERE `admin_user_id` = " . $chat_id);
        sendMessage($chat_id, "✅ عملیات لغو شد.");
        sendAdminPanelMenu($chat_id);
        exit;
    }
    
    if ($text_message == "/admin") {
        sendAdminPanelMenu($chat_id);
        exit;
    }

    $admin_state = query("SELECT", "admin_process_state", false, [["key"=>"admin_user_id","condition"=>"=","value"=>$chat_id], ["key"=>"step", "condition"=>">", "value"=>0]], false, "id DESC");
    if ($admin_state) {
        $process_name = $admin_state->process_name;
        $step = $admin_state->step;
        $step_data = json_decode($admin_state->step_data, true) ?: [];

        // فرآیندهای افزودن محصول و دسته‌بندی
        if ($process_name == 'add_category') {
            if ($step == 1) { // دریافت نام دسته‌بندی
                $step_data['name'] = $text_message;
                query("UPDATE", "admin_process_state", ["step" => 2, "step_data" => json_encode($step_data)], [["key"=>"id","condition"=>"=","value"=>$admin_state->id]]);
                sendMessage($chat_id, "<b>مرحله ۲:</b>\n\nیک آیکون (ایموجی) برای دسته‌بندی بفرستید (برای لغو /cancel را ارسال کنید)");
            } elseif ($step == 2) { // دریافت آیکون و ذخیره نهایی
                $step_data['icon'] = $text_message;
                query("CREATE", "categories", ["name" => $step_data['name'], "icon" => $step_data['icon'], "status" => "enable"]);
                $conn->query("DELETE FROM `admin_process_state` WHERE `id` = " . $admin_state->id);
                sendMessage($chat_id, "✅ دسته‌بندی '<b>{$step_data['name']}</b>' با موفقیت اضافه شد.");
                sendAdminPanelMenu($chat_id);
            }
        }
        elseif ($process_name == 'add_product') {
            if ($step == 1) { // دریافت نام
                $step_data['title'] = $text_message;
                query("UPDATE", "admin_process_state", ["step" => 2, "step_data" => json_encode($step_data)], [["key"=>"id","condition"=>"=","value"=>$admin_state->id]]);
                sendMessage($chat_id, "<b>مرحله ۲:</b>\n\nتوضیحات محصول را وارد کنید:\n(برای لغو /cancel را ارسال کنید)");
            } elseif ($step == 2) { // دریافت توضیحات
                $step_data['description'] = $text_message;
                query("UPDATE", "admin_process_state", ["step" => 3, "step_data" => json_encode($step_data)], [["key"=>"id","condition"=>"=","value"=>$admin_state->id]]);
                sendMessage($chat_id, "<b>مرحله ۳:</b>\n\nقیمت محصول را به تومان (فقط عدد) وارد کنید:\n(برای لغو /cancel را ارسال کنید)");
            } elseif ($step == 3) { // دریافت قیمت
                if(is_numeric($text_message)){
                    $step_data['price'] = $text_message;
                    query("UPDATE", "admin_process_state", ["step" => 4, "step_data" => json_encode($step_data)], [["key"=>"id","condition"=>"=","value"=>$admin_state->id]]);
                    sendMessage($chat_id, "<b>مرحله ۴:</b>\n\nنام نویسنده/مدرس را وارد کنید:\n(برای لغو /cancel را ارسال کنید)");
                } else {
                    sendMessage($chat_id, "❌ لطفاً قیمت را فقط به صورت عدد وارد کنید.");
                }
            } elseif ($step == 4) { // دریافت نویسنده
                $step_data['author'] = $text_message;
                query("UPDATE", "admin_process_state", ["step" => 5, "step_data" => json_encode($step_data)], [["key"=>"id","condition"=>"=","value"=>$admin_state->id]]);
                sendMessage($chat_id, "<b>مرحله ۵:</b>\n\nآدرس URL تصویر محصول را وارد کنید:\n(برای لغو /cancel را ارسال کنید)");
            } elseif ($step == 5) { // دریافت URL عکس و نمایش دسته‌بندی‌ها
                $step_data['image_url'] = $text_message;
                query("UPDATE", "admin_process_state", ["step" => 6, "step_data" => json_encode($step_data)], [["key"=>"id","condition"=>"=","value"=>$admin_state->id]]);
                $categories = query("SELECT", "categories", false, [["key" => "status", "condition" => "=", "value" => "enable"]], true);
                $option = [];
                foreach ($categories as $cat) {
                    $option[] = array($telegram->buildInlineKeyBoardButton($cat->name, '', 'admin_p_select_cat_' . $cat->id));
                }
                $option[] = array($telegram->buildInlineKeyBoardButton("لغو عملیات ❌", '', 'admin_cancel_process'));
                $keyb = $telegram->buildInlineKeyBoard($option);
                sendMessage($chat_id, "<b>مرحله نهایی (۶):</b>\n\nدسته‌بندی این محصول را انتخاب کنید:", $keyb);
            }
        }
        exit;
    }
}



// =======================================================================
// پردازش دکمه‌های شیشه‌ای (Callback Query) برای ادمین
// =======================================================================
if ($callback_data) {
    if ($callback_data == 'admin_panel' || $callback_data == 'start') {
        if ($callback_data == 'start') sendMainKeyboardMenu($chat_id, $mesasge_id);
        else sendAdminPanelMenu($chat_id, $mesasge_id);
    }
    elseif ($callback_data == 'admin_stats') {
        $users_count = $conn->query("SELECT count(*) FROM users")->fetchColumn();
        $products_count = $conn->query("SELECT count(*) FROM products")->fetchColumn();
        $completed_orders = $conn->query("SELECT count(*) FROM orders WHERE status = 'payed'")->fetchColumn();
        $stats_text = "📊 <b>آمار کلی ربات:</b>\n\n";
        $stats_text .= "👤 تعداد کل کاربران: <b>{$users_count}</b>\n";
        $stats_text .= "📦 تعداد کل محصولات: <b>{$products_count}</b>\n";
        $stats_text .= "✅ تعداد سفارشات تکمیل شده: <b>{$completed_orders}</b>\n";
        $keyb = $telegram->buildInlineKeyBoard([ [ $telegram->buildInlineKeyBoardButton("بازگشت 🔙", '', 'admin_panel') ] ]);
        sendMessage($chat_id, $stats_text, $keyb, $mesasge_id);
    }
    elseif ($callback_data == 'admin_add_category') {
        query("CREATE", "admin_process_state", ["admin_user_id" => $chat_id, "process_name" => "add_category", "step" => 1]);
        sendMessage($chat_id, "<b>مرحله ۱: افزودن دسته‌بندی</b>\n\nلطفاً نام دسته‌بندی جدید را وارد کنید:", false, $mesasge_id);
    }
    elseif ($callback_data == 'admin_add_product') {
        query("CREATE", "admin_process_state", ["admin_user_id" => $chat_id, "process_name" => "add_product", "step" => 1]);
        sendMessage($chat_id, "<b>مرحله ۱: افزودن محصول</b>\n\nلطفاً نام محصول جدید را وارد کنید:", false, $mesasge_id);
    }
    elseif (strpos($callback_data, 'admin_p_select_cat_') === 0) { // انتخاب دسته‌بندی برای محصول
        $category_id = str_replace('admin_p_select_cat_', '', $callback_data);
        $admin_state = query("SELECT", "admin_process_state", false, [["key"=>"admin_user_id","condition"=>"=","value"=>$chat_id], ["key"=>"process_name","condition"=>"=","value"=>"add_product"]], false, "id DESC");
        if ($admin_state) {
            $step_data = json_decode($admin_state->step_data, true);
            query("CREATE", "products", [
                'title' => $step_data['title'],
                'description' => $step_data['description'],
                'price' => $step_data['price'],
                'author' => $step_data['author'],
                'image_url' => $step_data['image_url'],
                'category_id' => $category_id,
                'status' => 'enable'
            ]);
            $conn->query("DELETE FROM `admin_process_state` WHERE `id` = " . $admin_state->id);
            sendMessage($chat_id, "✅ محصول '<b>{$step_data['title']}</b>' با موفقیت اضافه شد.", false, $mesasge_id);
            sendAdminPanelMenu($chat_id);
        }
    }
    // دکمه‌های دیگر که می‌توانید در آینده کامل کنید
    else {
        sendMessage($chat_id, "این بخش در حال توسعه است.", false, $mesasge_id);
    }
}

// =======================================================================
// پردازش پیام‌های متنی برای ادمین
// =======================================================================
elseif ($text_message) {
    if ($text_message == "/admin") {
        sendAdminPanelMenu($chat_id, $mesasge_id);
        exit;
    }

    $admin_state = query("SELECT", "admin_process_state", false, [["key"=>"admin_user_id","condition"=>"=","value"=>$chat_id], ["key"=>"step", "condition"=>">", "value"=>0]], false, "id DESC");
    if ($admin_state) {
        $process_name = $admin_state->process_name;
        $step = $admin_state->step;
        $step_data = json_decode($admin_state->step_data, true) ?: [];

        if ($process_name == 'add_category') {
            if ($step == 1) { // دریافت نام دسته‌بندی
                $step_data['name'] = $text_message;
                query("UPDATE", "admin_process_state", ["step" => 2, "step_data" => json_encode($step_data)], [["key"=>"id","condition"=>"=","value"=>$admin_state->id]]);
                sendMessage($chat_id, "<b>مرحله ۲:</b>\n\nیک آیکون (ایموجی) برای این دسته‌بندی بفرستید (مثال: ✨)");
            } elseif ($step == 2) { // دریافت آیکون و ذخیره نهایی
                $step_data['icon'] = $text_message;
                query("CREATE", "categories", ["name" => $step_data['name'], "icon" => $step_data['icon'], "status" => "enable"]);
                $conn->query("DELETE FROM `admin_process_state` WHERE `id` = " . $admin_state->id);
                sendMessage($chat_id, "✅ دسته‌بندی '<b>{$step_data['name']}</b>' با موفقیت اضافه شد.");
                sendAdminPanelMenu($chat_id);
            }
        }
        elseif ($process_name == 'add_product') {
            if ($step == 1) { // دریافت نام
                $step_data['title'] = $text_message;
                query("UPDATE", "admin_process_state", ["step" => 2, "step_data" => json_encode($step_data)], [["key"=>"id","condition"=>"=","value"=>$admin_state->id]]);
                sendMessage($chat_id, "<b>مرحله ۲:</b>\n\nتوضیحات محصول را وارد کنید:");
            } elseif ($step == 2) { // دریافت توضیحات
                $step_data['description'] = $text_message;
                query("UPDATE", "admin_process_state", ["step" => 3, "step_data" => json_encode($step_data)], [["key"=>"id","condition"=>"=","value"=>$admin_state->id]]);
                sendMessage($chat_id, "<b>مرحله ۳:</b>\n\nقیمت محصول را به تومان (فقط عدد) وارد کنید:");
            } elseif ($step == 3) { // دریافت قیمت
                if(is_numeric($text_message)){
                    $step_data['price'] = $text_message;
                    query("UPDATE", "admin_process_state", ["step" => 4, "step_data" => json_encode($step_data)], [["key"=>"id","condition"=>"=","value"=>$admin_state->id]]);
                    sendMessage($chat_id, "<b>مرحله ۴:</b>\n\nنام نویسنده/مدرس را وارد کنید:");
                } else {
                    sendMessage($chat_id, "❌ لطفاً قیمت را فقط به صورت عدد وارد کنید.");
                }
            } elseif ($step == 4) { // دریافت نویسنده
                $step_data['author'] = $text_message;
                query("UPDATE", "admin_process_state", ["step" => 5, "step_data" => json_encode($step_data)], [["key"=>"id","condition"=>"=","value"=>$admin_state->id]]);
                sendMessage($chat_id, "<b>مرحله ۵:</b>\n\nآدرس URL تصویر محصول را وارد کنید:");
            } elseif ($step == 5) { // دریافت URL عکس و نمایش دسته‌بندی‌ها
                $step_data['image_url'] = $text_message;
                query("UPDATE", "admin_process_state", ["step" => 6, "step_data" => json_encode($step_data)], [["key"=>"id","condition"=>"=","value"=>$admin_state->id]]);
                $categories = query("SELECT", "categories", false, [["key" => "status", "condition" => "=", "value" => "enable"]], true);
                $option = [];
                foreach ($categories as $cat) {
                    $option[] = array($telegram->buildInlineKeyBoardButton($cat->name, '', 'admin_p_select_cat_' . $cat->id));
                }
                $keyb = $telegram->buildInlineKeyBoard($option);
                sendMessage($chat_id, "<b>مرحله نهایی (۶):</b>\n\nدسته‌بندی این محصول را انتخاب کنید:", $keyb);
            }
        }
        exit;
    }
}