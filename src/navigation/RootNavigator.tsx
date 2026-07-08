import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuth } from '../auth/AuthContext';
import type { AuthStackParamList, RootStackParamList } from './types';
import SignInScreen from '../screens/SignInScreen';
import SignUpScreen from '../screens/SignUpScreen';
import HomeScreen from '../screens/HomeScreen';
import SettingsScreen from '../screens/SettingsScreen';
import MyScansScreen from '../screens/MyScansScreen';
import PhotoScanScreen from '../screens/PhotoScanScreen';
import VideoScanScreen from '../screens/VideoScanScreen';
import LidarScanScreen from '../screens/LidarScanScreen';
import StatusScreen from '../screens/StatusScreen';
import ViewerScreen from '../screens/ViewerScreen';
import CaptureDetailScreen from '../screens/CaptureDetailScreen';

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const MainStack = createNativeStackNavigator<RootStackParamList>();

function AuthNavigator() {
  return (
    <AuthStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: '#0e0e0e' },
        headerTintColor: '#fff',
        contentStyle: { backgroundColor: '#0e0e0e' },
      }}
    >
      <AuthStack.Screen name="SignIn" component={SignInScreen} options={{ headerShown: false }} />
      <AuthStack.Screen name="SignUp" component={SignUpScreen} options={{ headerShown: false }} />
    </AuthStack.Navigator>
  );
}

function MainNavigator() {
  return (
    <MainStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: '#0e0e0e' },
        headerTintColor: '#fff',
        contentStyle: { backgroundColor: '#0e0e0e' },
      }}
    >
      <MainStack.Screen name="Home" component={HomeScreen} options={{ headerShown: false }} />
      <MainStack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Ayarlar' }} />
      <MainStack.Screen name="MyScans" component={MyScansScreen} options={{ title: 'Taramalarım' }} />
      <MainStack.Screen name="PhotoScan" component={PhotoScanScreen} options={{ title: 'Foto ile Tara' }} />
      <MainStack.Screen name="VideoScan" component={VideoScanScreen} options={{ title: 'Video ile Tara' }} />
      <MainStack.Screen name="LidarScan" component={LidarScanScreen} options={{ title: 'LiDAR ile Tara' }} />
      <MainStack.Screen name="Status" component={StatusScreen} options={{ title: 'İşleniyor', headerBackVisible: false }} />
      <MainStack.Screen name="Viewer" component={ViewerScreen} options={{ title: '3D Model' }} />
      <MainStack.Screen name="CaptureDetail" component={CaptureDetailScreen} options={{ title: 'Tarama' }} />
    </MainStack.Navigator>
  );
}

export default function RootNavigator() {
  const { session, isLoading } = useAuth();

  if (isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: '#0e0e0e', justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color="#4a9eff" />
      </View>
    );
  }

  return (
    <NavigationContainer theme={DarkTheme}>
      {session ? <MainNavigator /> : <AuthNavigator />}
    </NavigationContainer>
  );
}
