package com.piassist.app;

import android.os.Bundle;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private boolean handlingBack = false;
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (handlingBack || getBridge() == null || getBridge().getWebView() == null) return;
                handlingBack = true;
                getBridge().getWebView().evaluateJavascript(
                    "(function(){return typeof window.pressureLensBack === 'function' ? window.pressureLensBack() : true;})()",
                    result -> {
                        handlingBack = false;
                        // Only the home screen explicitly returns false. Never exit while loading.
                        if ("false".equals(result)) finish();
                    }
                );
            }
        });
    }
}
