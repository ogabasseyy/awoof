/**
 * Receipts Page
 */

'use client';

import { useState, useEffect } from 'react';
import { Receipt, ChevronLeft, Download, Eye, Calendar } from 'lucide-react';
import ProtectedRoute from '@/components/ProtectedRoute';
import { useAuth } from '@/contexts/AuthContext';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import apiClient from '@/lib/api-client';
import { formatCurrency } from '@/lib/format';
import toast from 'react-hot-toast';

interface ReceiptItem {
    id: string;
    transactionId: string;
    productName: string;
    vendorName: string;
    amount: number;
    discount: number;
    finalAmount: number;
    date: string;
    status: 'completed' | 'pending' | 'failed';
}

export default function ReceiptsPage() {
    const { } = useAuth();
    const [receipts, setReceipts] = useState<ReceiptItem[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        fetchReceipts();
    }, []);

    const fetchReceipts = async () => {
        try {
            setIsLoading(true);
            // Fetch from API
            const response = await apiClient.get('/students/purchases').catch(() => null);

            if (response?.data?.data?.transactions) {
                const transactions = response.data.data.transactions;
                const formattedReceipts: ReceiptItem[] = transactions.map((transaction: {
                    id: string;
                    transactionId: string;
                    amount: number;
                    discountAmount: number;
                    finalAmount?: number;
                    status: string;
                    createdAt: string;
                    product?: {
                        name?: string;
                        vendorName?: string;
                    } | null;
                }) => ({
                    id: transaction.id,
                    transactionId: transaction.transactionId || transaction.id,
                    productName: transaction.product?.name || 'Product',
                    vendorName: transaction.product?.vendorName || 'Vendor',
                    amount: transaction.amount || 0,
                    discount: transaction.discountAmount || 0,
                    finalAmount: transaction.finalAmount || (transaction.amount - transaction.discountAmount),
                    date: transaction.createdAt || new Date().toISOString(),
                    status: (transaction.status === 'completed' ? 'completed' :
                        transaction.status === 'pending' ? 'pending' :
                            transaction.status === 'failed' ? 'failed' : 'completed') as 'completed' | 'pending' | 'failed',
                }));
                setReceipts(formattedReceipts);
            } else {
                // Mock data for development
                setReceipts([
                    {
                        id: '1',
                        transactionId: 'TXN-001',
                        productName: 'Travel Package Deal',
                        vendorName: 'Travel Agency',
                        amount: 50000,
                        discount: 5000,
                        finalAmount: 45000,
                        date: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
                        status: 'completed',
                    },
                    {
                        id: '2',
                        transactionId: 'TXN-002',
                        productName: 'Restaurant Meal',
                        vendorName: 'Food Place',
                        amount: 5000,
                        discount: 500,
                        finalAmount: 4500,
                        date: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
                        status: 'completed',
                    },
                ]);
            }
        } catch (error) {
            console.error('Error fetching receipts:', error);
        } finally {
            setIsLoading(false);
        }
    };


    const formatDate = (dateString: string) => {
        const date = new Date(dateString);
        return date.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    };

    const handleDownload = (_receipt: ReceiptItem) => {
        toast('Receipt download will be available soon');
    };

    const handleView = (_receipt: ReceiptItem) => {
        toast('Receipt details will be available soon');
    };

    return (
        <ProtectedRoute requiredRole="student">
            <div className="min-h-screen bg-gray-50">
                {/* Mobile View */}
                <div className="block md:hidden">
                    <div className="bg-white sticky top-0 z-10 border-b border-gray-200">
                        <div className="flex items-center gap-4 px-4 py-4">
                            <Link href="/student/profile">
                                <ChevronLeft className="h-6 w-6 text-gray-600" />
                            </Link>
                            <div className="flex items-center gap-2">
                                <Receipt className="h-5 w-5 text-gray-600" />
                                <h1 className="text-lg font-semibold text-gray-900">Receipts</h1>
                            </div>
                        </div>
                    </div>

                    <div className="px-4 py-4">
                        {isLoading ? (
                            <div className="text-center py-12">
                                <p className="text-gray-500">Loading...</p>
                            </div>
                        ) : receipts.length === 0 ? (
                            <div className="text-center py-12">
                                <Receipt className="h-12 w-12 text-gray-300 mx-auto mb-4" />
                                <p className="text-gray-500">No receipts yet</p>
                                <Link href="/marketplace">
                                    <Button className="mt-4">Browse Marketplace</Button>
                                </Link>
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {receipts.map((receipt) => (
                                    <div key={receipt.id} className="bg-white rounded-lg p-4 border border-gray-200">
                                        <div className="flex items-start justify-between mb-3">
                                            <div className="flex-1">
                                                <h3 className="font-semibold text-gray-900 mb-1">{receipt.productName}</h3>
                                                <p className="text-sm text-gray-600">{receipt.vendorName}</p>
                                                <p className="text-xs text-gray-500 mt-1">Transaction: {receipt.transactionId}</p>
                                            </div>
                                            <span className={`text-xs font-medium px-2 py-1 rounded ${receipt.status === 'completed' ? 'bg-green-100 text-green-800' :
                                                receipt.status === 'pending' ? 'bg-yellow-100 text-yellow-800' :
                                                    'bg-red-100 text-red-800'
                                                }`}>
                                                {receipt.status}
                                            </span>
                                        </div>
                                        <div className="space-y-2 mb-3 pt-3 border-t border-gray-100">
                                            <div className="flex justify-between text-sm">
                                                <span className="text-gray-600">Original Price:</span>
                                                <span className="text-gray-900">{formatCurrency(receipt.amount)}</span>
                                            </div>
                                            <div className="flex justify-between text-sm">
                                                <span className="text-gray-600">Discount:</span>
                                                <span className="text-green-600">-{formatCurrency(receipt.discount)}</span>
                                            </div>
                                            <div className="flex justify-between text-sm font-semibold pt-2 border-t border-gray-100">
                                                <span className="text-gray-900">Total Paid:</span>
                                                <span className="text-gray-900">{formatCurrency(receipt.finalAmount)}</span>
                                            </div>
                                        </div>
                                        <div className="flex items-center justify-between pt-3 border-t border-gray-100">
                                            <div className="flex items-center gap-2 text-xs text-gray-500">
                                                <Calendar className="h-4 w-4" />
                                                <span>{formatDate(receipt.date)}</span>
                                            </div>
                                            <div className="flex gap-2">
                                                <button
                                                    onClick={() => handleView(receipt)}
                                                    className="p-2 hover:bg-gray-100 rounded"
                                                    title="View"
                                                >
                                                    <Eye className="h-4 w-4 text-gray-600" />
                                                </button>
                                                <button
                                                    onClick={() => handleDownload(receipt)}
                                                    className="p-2 hover:bg-gray-100 rounded"
                                                    title="Download"
                                                >
                                                    <Download className="h-4 w-4 text-gray-600" />
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                {/* Web View */}
                <div className="hidden md:block">
                    <div className="container mx-auto max-w-4xl px-4 py-8">
                        <div className="flex items-center gap-3 mb-6">
                            <Link href="/student/profile">
                                <Button variant="ghost" size="sm">
                                    <ChevronLeft className="h-4 w-4 mr-2" />
                                    Back
                                </Button>
                            </Link>
                            <div className="flex items-center gap-2">
                                <Receipt className="h-6 w-6 text-gray-600" />
                                <h1 className="text-2xl font-semibold text-gray-900">Receipts</h1>
                            </div>
                        </div>

                        {isLoading ? (
                            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
                                <p className="text-gray-500">Loading...</p>
                            </div>
                        ) : receipts.length === 0 ? (
                            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
                                <Receipt className="h-12 w-12 text-gray-300 mx-auto mb-4" />
                                <p className="text-gray-500 mb-4">No receipts yet</p>
                                <Link href="/marketplace">
                                    <Button>Browse Marketplace</Button>
                                </Link>
                            </div>
                        ) : (
                            <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
                                <div className="divide-y divide-gray-200">
                                    {receipts.map((receipt) => (
                                        <div key={receipt.id} className="p-6 hover:bg-gray-50 transition-colors">
                                            <div className="flex items-start justify-between gap-4 mb-4">
                                                <div className="flex-1">
                                                    <div className="flex items-center gap-3 mb-2">
                                                        <h3 className="text-lg font-semibold text-gray-900">{receipt.productName}</h3>
                                                        <span className={`text-xs font-medium px-2 py-1 rounded ${receipt.status === 'completed' ? 'bg-green-100 text-green-800' :
                                                            receipt.status === 'pending' ? 'bg-yellow-100 text-yellow-800' :
                                                                'bg-red-100 text-red-800'
                                                            }`}>
                                                            {receipt.status}
                                                        </span>
                                                    </div>
                                                    <p className="text-gray-600 mb-1">{receipt.vendorName}</p>
                                                    <p className="text-sm text-gray-500">Transaction: {receipt.transactionId}</p>
                                                </div>
                                                <div className="flex gap-2">
                                                    <button
                                                        onClick={() => handleView(receipt)}
                                                        className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                                                        title="View"
                                                    >
                                                        <Eye className="h-5 w-5 text-gray-600" />
                                                    </button>
                                                    <button
                                                        onClick={() => handleDownload(receipt)}
                                                        className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                                                        title="Download"
                                                    >
                                                        <Download className="h-5 w-5 text-gray-600" />
                                                    </button>
                                                </div>
                                            </div>
                                            <div className="grid grid-cols-3 gap-4 pt-4 border-t border-gray-100">
                                                <div>
                                                    <p className="text-sm text-gray-600 mb-1">Original Price</p>
                                                    <p className="text-gray-900 font-medium">{formatCurrency(receipt.amount)}</p>
                                                </div>
                                                <div>
                                                    <p className="text-sm text-gray-600 mb-1">Discount</p>
                                                    <p className="text-green-600 font-medium">-{formatCurrency(receipt.discount)}</p>
                                                </div>
                                                <div>
                                                    <p className="text-sm text-gray-600 mb-1">Total Paid</p>
                                                    <p className="text-gray-900 font-semibold">{formatCurrency(receipt.finalAmount)}</p>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-2 mt-4 pt-4 border-t border-gray-100">
                                                <Calendar className="h-4 w-4 text-gray-400" />
                                                <span className="text-sm text-gray-500">{formatDate(receipt.date)}</span>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </ProtectedRoute>
    );
}
