package com.ocreditor.app;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(NativeOcrPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
